import type { EventRow, EventStore } from '@ellie/db'
import type {
	RealtimeStore,
	BranchEvent
} from '../../lib/realtime-store'
import type { ChannelDeliveryTarget } from './types'
import type { ChannelProvider } from './provider'
import type { ChannelReplyPayload } from './reply-payload'
import { resolveMedia } from './media-resolver'
import type { TtsPostProcessor } from '../../lib/tts-post-processor'
import {
	PENDING_ROW_TTL,
	PENDING_ROW_MAX,
	COMPOSING_COOLDOWN_MS,
	parseRowPayload,
	targetKey,
	checkpointKey,
	buildOutboundItems,
	type TtsConfig,
	type OutboundItem,
	type PendingDelivery,
	type PendingRowEntry,
	type LiveTextState,
	type LiveDeliveryEvent
} from './delivery-helpers'
import {
	extractReplyPayloads,
	extractStreamingRow,
	isLiveTextEligible,
	resolveMediaRef,
	mediaLocalRoots
} from './delivery-extract'
import {
	preparePayloadsForDelivery,
	type DeliveryTtsDeps
} from './delivery-tts'

/**
 * In-memory registry that tracks channel-triggered runs and routes
 * assistant replies back through the originating channel provider.
 *
 * Persists a delivery checkpoint after every individual outbound send
 * so crash recovery can resume from the exact next unsent item.
 *
 * Supports multiple contributing external targets per run and
 * row-based pending binding for follow-up/queued messages whose
 * runId is not yet known.
 *
 * Only runs with channel contributors are registered here;
 * web/CLI runs never enter this registry.
 */
export class ChannelDeliveryRegistry {
	readonly #pending = new Map<string, PendingDelivery>()
	readonly #pendingByRow = new Map<
		number,
		PendingRowEntry
	>()
	/** Live-text state keyed by `${runId}:${targetKey}:${assistantRowId}` */
	readonly #liveState = new Map<string, LiveTextState>()
	readonly #store: RealtimeStore
	readonly #getProvider: (
		id: string
	) => ChannelProvider | undefined
	readonly #dataDir?: string
	readonly #ttsDeps: DeliveryTtsDeps
	readonly #watchedBranches = new Set<string>()
	readonly #unsubscribers: Array<() => void> = []

	constructor(opts: {
		store: RealtimeStore
		getProvider: (id: string) => ChannelProvider | undefined
		/** Data directory for upload/media resolution. */
		dataDir?: string
		/** Path to credentials file for API key lookup (ElevenLabs, etc.). */
		credentialsPath?: string
		/** Returns TTS config for auto-TTS in delivery pipeline. */
		getTtsConfig?: () => TtsConfig | undefined
	}) {
		this.#store = opts.store
		this.#getProvider = opts.getProvider
		this.#dataDir = opts.dataDir
		this.#ttsDeps = {
			credentialsPath: opts.credentialsPath,
			getTtsConfig: opts.getTtsConfig,
			store: opts.store
		}
	}

	/** Inject TtsPostProcessor so delivery can await its audio instead of racing. */
	setTtsPostProcessor(tpp: TtsPostProcessor): void {
		this.#ttsDeps.ttsPostProcessor = tpp
	}

	/** Register a delivery target for a channel-triggered run. Additive — multiple targets per run are supported. */
	register(
		runId: string,
		branchId: string,
		target: ChannelDeliveryTarget
	): void {
		const key = targetKey(target)
		const existing = this.#pending.get(runId)
		if (existing) {
			const current = existing.targets.get(key)
			existing.targets.set(key, {
				target,
				deliveredKeys: current?.deliveredKeys ?? new Set(),
				lastComposingAt: current?.lastComposingAt ?? 0
			})
			return
		}

		this.#pending.set(runId, {
			branchId,
			targets: new Map([
				[
					key,
					{
						target,
						deliveredKeys: new Set(),
						lastComposingAt: 0
					}
				]
			]),
			inFlight: Promise.resolve()
		})
	}

	/**
	 * Register a delivery target against a user_message row whose runId
	 * is not yet known (follow-up or queued path). When the row's runId
	 * is backfilled via updateEventRunId, the target is auto-promoted
	 * to a run-level registration.
	 */
	registerPending(
		rowId: number,
		branchId: string,
		target: ChannelDeliveryTarget
	): void {
		this.#pendingByRow.set(rowId, {
			branchId,
			target,
			createdAt: Date.now()
		})
		this.#sweepStalePending()
	}

	/** Remove stale pending entries that were never promoted. */
	#sweepStalePending(): void {
		if (this.#pendingByRow.size <= PENDING_ROW_MAX) return
		const now = Date.now()
		for (const [rowId, entry] of this.#pendingByRow) {
			if (now - entry.createdAt > PENDING_ROW_TTL) {
				this.#pendingByRow.delete(rowId)
			}
		}
	}

	/** Subscribe to a branch's events for run_closed detection and runId backfill. Idempotent per branchId. */
	watchBranch(branchId: string): void {
		if (this.#watchedBranches.has(branchId)) return
		this.#watchedBranches.add(branchId)

		const unsub = this.#store.subscribeToBranch(
			branchId,
			(event: BranchEvent) => {
				if (event.type === 'update') {
					this.#promotePendingRow(event.event)
					this.#handleLiveRowEvent(event.event, branchId)
					return
				}

				if (event.type !== 'append') return
				this.#handleLiveRowEvent(event.event, branchId)

				if (event.event.type !== 'run_closed') return
				const runId = event.event.runId
				if (!runId) return
				this.#handleRunClosed(runId, branchId).catch(
					err => {
						console.error(
							'[delivery] handleRunClosed failed:',
							err
						)
					}
				)
			}
		)
		this.#unsubscribers.push(unsub)
	}

	#promotePendingRow(row: EventRow): void {
		if (!row.runId) return
		const pending = this.#pendingByRow.get(row.id)
		if (!pending) return
		this.#pendingByRow.delete(row.id)
		this.register(
			row.runId,
			pending.branchId,
			pending.target
		)
	}

	#handleLiveRowEvent(
		row: EventRow,
		branchId: string
	): void {
		if (!row.runId) return
		if (row.type === 'run_closed') return

		if (row.type === 'tool_execution') {
			this.#sendComposingForRun(row.runId)
			return
		}
		if (row.type !== 'assistant_message') return

		const isFinal = this.#isFinalAssistantMessageRow(row)

		if (!isFinal) {
			// Streaming row update — attempt live text
			this.#handleLiveTextUpdate(
				row.runId,
				branchId,
				row.id
			)
			this.#sendComposingForRun(row.runId)
			return
		}

		// Row finalized — finalize live text, then run normal delivery
		this.#handleLiveTextFinalize(row.runId, branchId)
		this.#sendComposingForRun(row.runId)
		this.#queueRunDelivery(row.runId, async () => {
			await this.#deliverPendingReplies(
				row.runId!,
				branchId,
				false
			)
		}).catch(err => {
			console.error(
				'[delivery] live assistant delivery failed:',
				err
			)
		})
	}

	#isFinalAssistantMessageRow(row: EventRow): boolean {
		if (row.type !== 'assistant_message') return false
		const parsed = parseRowPayload(row)
		if (!parsed) return false
		return parsed.streaming === false
	}

	#queueRunDelivery(
		runId: string,
		task: () => Promise<void>
	): Promise<void> {
		const delivery = this.#pending.get(runId)
		if (!delivery) return Promise.resolve()

		const next = delivery.inFlight.then(task, task)
		delivery.inFlight = next.catch(() => {})
		return next
	}

	/** Send composing indicators to all targets registered for a run. */
	#sendComposingForRun(runId: string): void {
		const delivery = this.#pending.get(runId)
		if (!delivery) return
		const now = Date.now()

		for (const targetState of delivery.targets.values()) {
			if (
				now - targetState.lastComposingAt <
				COMPOSING_COOLDOWN_MS
			) {
				continue
			}

			const provider = this.#getProvider(
				targetState.target.channelId
			)
			if (!provider?.sendComposing) continue
			targetState.lastComposingAt = now
			provider
				.sendComposing(targetState.target)
				.catch(() => {})
		}
	}

	async #handleRunClosed(
		runId: string,
		branchId: string
	): Promise<void> {
		if (!this.#pending.has(runId)) {
			return
		}

		// Finalize any still-streaming live text before final delivery
		this.#handleLiveTextFinalize(runId, branchId)

		await this.#queueRunDelivery(runId, async () => {
			// Wait for live text finalization to complete
			await this.#awaitLiveEdits(runId)
			await this.#deliverPendingReplies(
				runId,
				branchId,
				true
			)
		})

		// Clean up live state for this run
		for (const key of this.#liveState.keys()) {
			if (key.startsWith(`${runId}:`)) {
				this.#liveState.delete(key)
			}
		}
		this.#pending.delete(runId)
	}

	/** Wait for all pending live-text edit chains for a run to settle. */
	async #awaitLiveEdits(runId: string): Promise<void> {
		const chains: Promise<void>[] = []
		for (const [key, ls] of this.#liveState) {
			if (key.startsWith(`${runId}:`)) {
				chains.push(ls.editChain)
			}
		}
		if (chains.length > 0) {
			await Promise.allSettled(chains)
		}
	}

	/**
	 * Heuristic check: is a reply fully delivered based on the raw
	 * (unprepared) payload and the set of already-delivered keys?
	 * Used to skip expensive preparation (TTS synthesis) for items
	 * that were already sent in a prior delivery pass.
	 */
	#isReplyFullyDelivered(
		replyIndex: number,
		rawPayload: ChannelReplyPayload,
		deliveredKeys: Set<string>,
		hasTtsDirective?: boolean
	): boolean {
		// Primary item must be delivered
		if (!deliveredKeys.has(`${replyIndex}:0:0`))
			return false

		// Multi-attachment media: check all attachment keys
		if (rawPayload.mediaRefs) {
			for (
				let i = 1;
				i < rawPayload.mediaRefs.length;
				i++
			) {
				if (!deliveredKeys.has(`${replyIndex}:0:${i}`))
					return false
			}
		}

		// Explicit ttsDirective with media creates a second payload
		if (hasTtsDirective && rawPayload.mediaRefs?.length) {
			if (!deliveredKeys.has(`${replyIndex}:1:0`))
				return false
		}

		return true
	}

	async #deliverPendingReplies(
		runId: string,
		branchId: string,
		isRunClosed: boolean
	): Promise<void> {
		const delivery = this.#pending.get(runId)
		if (!delivery) return

		const replyPayloads = extractReplyPayloads(
			this.#store,
			branchId,
			runId
		)
		if (replyPayloads.length === 0) return

		// Cache prepared payloads per reply so TTS is called once
		// and shared across all targets.
		const preparedCache = new Map<
			number,
			ChannelReplyPayload[]
		>()

		for (const [tKey, targetState] of delivery.targets) {
			const provider = this.#getProvider(
				targetState.target.channelId
			)
			if (!provider) continue

			try {
				for (const [
					replyIndex,
					reply
				] of replyPayloads.entries()) {
					// Fast-path: skip preparation entirely for replies
					// that are already fully delivered (avoids TTS re-synthesis).
					if (
						this.#isReplyFullyDelivered(
							replyIndex,
							reply.payload,
							targetState.deliveredKeys,
							!!reply.ttsDirective
						)
					) {
						continue
					}

					// Skip text-only replies that were already live-delivered.
					// Media and TTS will still go through the normal path.
					if (
						this.#wasLiveDelivered(
							runId,
							tKey,
							reply.assistantRowId
						) &&
						!reply.payload.mediaRefs?.length
					) {
						continue
					}

					let payloads = preparedCache.get(replyIndex)
					if (!payloads) {
						payloads = await preparePayloadsForDelivery(
							reply.payload,
							branchId,
							runId,
							targetState.target.inboundMediaType?.startsWith(
								'audio/'
							) ?? false,
							isRunClosed && reply.isLastAssistantReply,
							this.#ttsDeps,
							Boolean(reply.ttsDirective),
							reply.assistantRowId
						)
						preparedCache.set(replyIndex, payloads)
					}

					const items = buildOutboundItems(
						replyIndex,
						payloads
					)
					for (const item of items) {
						const key = checkpointKey(item)
						if (targetState.deliveredKeys.has(key)) continue

						const sent = await this.#sendOutboundItem(
							provider,
							targetState.target,
							item
						)
						if (!sent) continue

						this.#persistCheckpoint(
							branchId,
							runId,
							targetState.target,
							item,
							reply.assistantRowId
						)
						targetState.deliveredKeys.add(key)
					}
				}
			} catch (err) {
				console.error(
					`[delivery] Failed to send reply via ${targetState.target.channelId}:`,
					err
				)
			}
		}
	}

	/** Send a single outbound item (text message or single media attachment). */
	async #sendOutboundItem(
		provider: ChannelProvider,
		target: ChannelDeliveryTarget,
		item: OutboundItem
	): Promise<boolean> {
		if (
			item.mediaRef &&
			typeof provider.sendMedia === 'function'
		) {
			const media = await resolveMedia(
				resolveMediaRef(item.mediaRef, this.#dataDir),
				{ localRoots: mediaLocalRoots(this.#dataDir) }
			)
			await provider.sendMedia(target, item.text, {
				buffer: media.buffer,
				mimetype: media.mimetype,
				fileName: media.fileName
			})
			return true
		}
		if (item.text) {
			await provider.sendMessage(target, item.text)
			return true
		}
		return false
	}

	/** Persist a delivery checkpoint for a single outbound item (idempotent via dedupeKey). */
	#persistCheckpoint(
		branchId: string,
		runId: string,
		target: ChannelDeliveryTarget,
		item: OutboundItem,
		assistantRowId: number
	): void {
		try {
			this.#store.appendEvent(
				branchId,
				'channel_delivered',
				{
					channelId: target.channelId,
					accountId: target.accountId,
					conversationId: target.conversationId,
					assistantRowId,
					replyIndex: item.replyIndex,
					payloadIndex: item.payloadIndex,
					attachmentIndex: item.attachmentIndex,
					kind: item.kind,
					deliveredAt: Date.now()
				},
				runId,
				`channel_delivered:${runId}:${targetKey(target)}:r${item.replyIndex}:p${item.payloadIndex}:a${item.attachmentIndex}`
			)
		} catch {
			// Best-effort — checkpoint dedup prevents double delivery
		}
	}

	#liveStateKey(
		runId: string,
		tKey: string,
		assistantRowId: number
	): string {
		return `${runId}:${tKey}:${assistantRowId}`
	}

	/** Push a live-text update for all targets of a run. */
	#handleLiveTextUpdate(
		runId: string,
		branchId: string,
		_rowId: number
	): void {
		const delivery = this.#pending.get(runId)
		if (!delivery) return

		const snapshot = extractStreamingRow(
			this.#store,
			branchId,
			runId
		)
		if (!snapshot) return
		if (!snapshot.streaming) return
		if (!isLiveTextEligible(snapshot)) return

		for (const [tKey, targetState] of delivery.targets) {
			const provider = this.#getProvider(
				targetState.target.channelId
			)
			if (!provider?.beginLiveText) continue

			const lsKey = this.#liveStateKey(
				runId,
				tKey,
				snapshot.assistantRowId
			)
			const existing = this.#liveState.get(lsKey)

			if (!existing) {
				// First non-empty text delta — begin live message
				const text = snapshot.text
				const ls: LiveTextState = {
					assistantRowId: snapshot.assistantRowId,
					handle: {},
					status: 'streaming',
					lastSentText: text,
					editChain: Promise.resolve()
				}
				this.#liveState.set(lsKey, ls)

				ls.editChain = ls.editChain
					.then(async () => {
						try {
							const result = await provider.beginLiveText!(
								targetState.target,
								text
							)
							ls.handle = result.handle
							this.#persistLiveDelivery(
								branchId,
								runId,
								targetState.target,
								ls
							)
						} catch (err) {
							console.error(
								'[delivery] beginLiveText failed:',
								err
							)
							// Remove so next update retries begin
							this.#liveState.delete(lsKey)
						}
					})
					.catch(() => {})
			} else if (existing.status === 'streaming') {
				// Subsequent delta — collapse and edit
				const text = snapshot.text
				if (text === existing.lastSentText) return

				existing.lastSentText = text
				existing.editChain = existing.editChain
					.then(async () => {
						if (existing.status !== 'streaming') return
						try {
							await provider.updateLiveText!(
								targetState.target,
								existing.handle,
								text
							)
						} catch {
							// Best-effort — next delta will retry
						}
					})
					.catch(() => {})
			}
		}
	}

	/** Finalize live text for all targets of a run. */
	#handleLiveTextFinalize(
		runId: string,
		branchId: string
	): void {
		const delivery = this.#pending.get(runId)
		if (!delivery) return

		const snapshot = extractStreamingRow(
			this.#store,
			branchId,
			runId
		)

		for (const [tKey, targetState] of delivery.targets) {
			const provider = this.#getProvider(
				targetState.target.channelId
			)
			if (!provider?.finalizeLiveText) continue

			// Find any live state for this run+target (any row)
			for (const [lsKey, ls] of this.#liveState) {
				if (!lsKey.startsWith(`${runId}:${tKey}:`)) continue
				if (ls.status !== 'streaming') continue

				ls.status = 'finalized'
				const finalText = snapshot?.text ?? ls.lastSentText

				ls.editChain = ls.editChain
					.then(async () => {
						try {
							await provider.finalizeLiveText!(
								targetState.target,
								ls.handle,
								finalText
							)
							ls.lastSentText = finalText
							this.#persistLiveDelivery(
								branchId,
								runId,
								targetState.target,
								ls
							)
						} catch (err) {
							console.error(
								'[delivery] finalizeLiveText failed:',
								err
							)
						}
					})
					.catch(() => {})
			}
		}
	}

	/** Persist a live-delivery event (separate from channel_delivered). */
	#persistLiveDelivery(
		branchId: string,
		runId: string,
		target: ChannelDeliveryTarget,
		ls: LiveTextState
	): void {
		try {
			const payload: LiveDeliveryEvent = {
				channelId: target.channelId,
				accountId: target.accountId,
				conversationId: target.conversationId,
				assistantRowId: ls.assistantRowId,
				handle: ls.handle,
				status: ls.status,
				lastSentText: ls.lastSentText,
				updatedAt: Date.now()
			}
			this.#store.appendEvent(
				branchId,
				'live_delivery',
				payload,
				runId,
				`live_delivery:${runId}:${targetKey(target)}:${ls.assistantRowId}:${ls.status}`
			)
		} catch {
			// Best-effort persistence
		}
	}

	/**
	 * Check if a finalized assistant row was already live-delivered
	 * and should be skipped in the normal delivery path.
	 */
	#wasLiveDelivered(
		runId: string,
		tKey: string,
		assistantRowId: number
	): boolean {
		const lsKey = this.#liveStateKey(
			runId,
			tKey,
			assistantRowId
		)
		const ls = this.#liveState.get(lsKey)
		return ls?.status === 'finalized'
	}

	/**
	 * Recover channel runs that closed but have unsent outbound items
	 * (e.g. server crashed mid-delivery).
	 * Resumes from the exact next unsent item using per-item checkpoints.
	 * Safe to call multiple times — checkpoints are idempotent.
	 */
	async recoverUndelivered(
		eventStore: EventStore,
		maxAgeMs = 30 * 60_000
	): Promise<number> {
		// Recover partial live messages — edit them to a failure note
		await this.#recoverLiveDeliveries(eventStore, maxAgeMs)

		const candidates =
			eventStore.findCandidateChannelRuns(maxAgeMs)
		if (candidates.length === 0) return 0

		let recovered = 0
		for (const row of candidates) {
			try {
				const target: ChannelDeliveryTarget = {
					channelId: row.channelId,
					accountId: row.accountId,
					conversationId: row.conversationId
				}

				// Load existing checkpoints for this run+target
				const checkpoints =
					eventStore.findDeliveryCheckpoints(
						row.branchId,
						row.runId,
						row.channelId,
						row.accountId,
						row.conversationId
					)
				const deliveredKeys = new Set(
					checkpoints.map(c => checkpointKey(c))
				)

				const replyPayloads = extractReplyPayloads(
					this.#store,
					row.branchId,
					row.runId
				)
				if (replyPayloads.length === 0) continue

				// Build all outbound items
				const allItems: Array<{
					item: OutboundItem
					assistantRowId: number
				}> = []
				for (const [
					replyIndex,
					reply
				] of replyPayloads.entries()) {
					const payloads = await preparePayloadsForDelivery(
						reply.payload,
						row.branchId,
						row.runId,
						false,
						reply.isLastAssistantReply,
						this.#ttsDeps,
						!!reply.ttsDirective,
						reply.assistantRowId
					)
					for (const item of buildOutboundItems(
						replyIndex,
						payloads
					)) {
						allItems.push({
							item,
							assistantRowId: reply.assistantRowId
						})
					}
				}

				// Filter to remaining unsent items
				const remaining = allItems.filter(
					({ item }) =>
						!deliveredKeys.has(checkpointKey(item))
				)
				if (remaining.length === 0) continue

				const provider = this.#getProvider(target.channelId)
				if (!provider) continue

				let sentAny = false
				for (const { item, assistantRowId } of remaining) {
					const sent = await this.#sendOutboundItem(
						provider,
						target,
						item
					)
					if (!sent) continue
					this.#persistCheckpoint(
						row.branchId,
						row.runId,
						target,
						item,
						assistantRowId
					)
					sentAny = true
				}

				if (sentAny) recovered++
			} catch (err) {
				console.error(
					`[delivery] Recovery failed for run ${row.runId}:`,
					err
				)
			}
		}

		return recovered
	}

	/** Recover partial live messages after crash — edit them to a failure note. */
	async #recoverLiveDeliveries(
		eventStore: EventStore,
		maxAgeMs: number
	): Promise<void> {
		const FAILURE_NOTE =
			'_(Message interrupted — please ask again)_'
		let liveRows: Awaited<
			ReturnType<
				typeof eventStore.findStreamingLiveDeliveries
			>
		>
		try {
			liveRows =
				eventStore.findStreamingLiveDeliveries(maxAgeMs)
		} catch {
			// Table/column may not exist yet on first run
			return
		}
		if (liveRows.length === 0) return

		for (const row of liveRows) {
			const provider = this.#getProvider(row.channelId)
			if (!provider?.failLiveText) continue
			const target: ChannelDeliveryTarget = {
				channelId: row.channelId,
				accountId: row.accountId,
				conversationId: row.conversationId
			}
			try {
				await provider.failLiveText(
					target,
					row.handle,
					FAILURE_NOTE
				)
				// Persist the failed status so we don't retry
				this.#store.appendEvent(
					row.branchId,
					'live_delivery',
					{
						channelId: row.channelId,
						accountId: row.accountId,
						conversationId: row.conversationId,
						assistantRowId: row.assistantRowId,
						handle: row.handle,
						status: 'failed',
						lastSentText: FAILURE_NOTE,
						updatedAt: Date.now()
					},
					row.runId,
					`live_delivery:${row.runId}:${targetKey(target)}:${row.assistantRowId}:failed`
				)
			} catch {
				// Best-effort — already-sent text remains visible
			}
		}
	}

	shutdown(): void {
		for (const unsub of this.#unsubscribers) unsub()
		this.#unsubscribers.length = 0
		this.#watchedBranches.clear()
		this.#pending.clear()
		this.#pendingByRow.clear()
		this.#liveState.clear()
	}
}
