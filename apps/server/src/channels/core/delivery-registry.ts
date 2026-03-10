import type { EventStore } from '@ellie/db'
import type {
	RealtimeStore,
	SessionEvent
} from '../../lib/realtime-store'
import type { ChannelDeliveryTarget } from './types'
import type { ChannelProvider } from './provider'
import * as path from 'node:path'
import {
	buildReplyPayload,
	type ChannelReplyPayload
} from './reply-payload'
import { resolveMedia } from './media-resolver'
import {
	maybeApplyTtsToPayload,
	type TtsAutoMode
} from './auto-tts'
import {
	resolveElevenLabsTtsConfig,
	resolveElevenLabsApiKeyAsync
} from '../../lib/tts'

export interface TtsConfig {
	mode: TtsAutoMode
	inboundAudio?: boolean
}

function targetKey(t: ChannelDeliveryTarget): string {
	return `${t.channelId}:${t.accountId}:${t.conversationId}`
}

interface PendingDelivery {
	sessionId: string
	targets: Map<string, ChannelDeliveryTarget>
}

interface PendingRowEntry {
	sessionId: string
	target: ChannelDeliveryTarget
	createdAt: number
}

const PENDING_ROW_TTL = 10 * 60_000 // 10 minutes
const PENDING_ROW_MAX = 500

/**
 * In-memory registry that tracks channel-triggered runs and routes
 * assistant replies back through the originating channel provider.
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
	readonly #store: RealtimeStore
	readonly #getProvider: (
		id: string
	) => ChannelProvider | undefined
	readonly #dataDir?: string
	readonly #credentialsPath?: string
	readonly #getTtsConfig?: () => TtsConfig | undefined
	readonly #watchedSessions = new Set<string>()
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
		/** @deprecated Use getTtsConfig instead. */
		getTtsAutoMode?: () => TtsAutoMode
	}) {
		this.#store = opts.store
		this.#getProvider = opts.getProvider
		this.#dataDir = opts.dataDir
		this.#credentialsPath = opts.credentialsPath
		// Support both new getTtsConfig and deprecated getTtsAutoMode
		this.#getTtsConfig =
			opts.getTtsConfig ??
			(opts.getTtsAutoMode
				? () => ({ mode: opts.getTtsAutoMode!() })
				: undefined)
	}

	/** Register a delivery target for a channel-triggered run. Additive — multiple targets per run are supported. */
	register(
		runId: string,
		sessionId: string,
		target: ChannelDeliveryTarget
	): void {
		const key = targetKey(target)
		const existing = this.#pending.get(runId)
		if (existing) {
			existing.targets.set(key, target)
		} else {
			this.#pending.set(runId, {
				sessionId,
				targets: new Map([[key, target]])
			})
		}
	}

	/**
	 * Register a delivery target against a user_message row whose runId
	 * is not yet known (follow-up or queued path). When the row's runId
	 * is backfilled via updateEventRunId, the target is auto-promoted
	 * to a run-level registration.
	 */
	registerPending(
		rowId: number,
		sessionId: string,
		target: ChannelDeliveryTarget
	): void {
		this.#pendingByRow.set(rowId, {
			sessionId,
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

	/** Subscribe to a session's events for run_closed detection and runId backfill. Idempotent per sessionId. */
	watchSession(sessionId: string): void {
		if (this.#watchedSessions.has(sessionId)) return
		this.#watchedSessions.add(sessionId)

		const unsub = this.#store.subscribeToSession(
			sessionId,
			(event: SessionEvent) => {
				// runId backfill on a pending row → promote to run-level
				if (event.type === 'update') {
					const row = event.event
					if (!row.runId) return
					const pending = this.#pendingByRow.get(row.id)
					if (!pending) return
					this.#pendingByRow.delete(row.id)
					this.register(
						row.runId,
						pending.sessionId,
						pending.target
					)
					return
				}

				// run_closed → deliver
				if (event.type !== 'append') return
				if (event.event.type !== 'run_closed') return
				const runId = event.event.runId
				if (!runId) return
				this.#handleRunClosed(runId, sessionId).catch(
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

	async #handleRunClosed(
		runId: string,
		sessionId: string
	): Promise<void> {
		const delivery = this.#pending.get(runId)
		if (!delivery) return // Not a channel-triggered run
		this.#pending.delete(runId)

		let payload = this.#extractFinalReplyPayload(
			sessionId,
			runId
		)
		if (!payload) return

		// Derive inboundAudio from targets (any audio inbound triggers 'inbound' mode)
		const hasAudioInbound = [
			...delivery.targets.values()
		].some(
			t => t.inboundMediaType?.startsWith('audio/') ?? false
		)

		// Apply auto-TTS if configured
		payload = await this.#applyAutoTts(
			payload,
			hasAudioInbound
		)

		// Always strip [[tts...]] directives from delivery text (auto-TTS or not)
		if (payload.text) {
			payload = {
				...payload,
				text:
					payload.text
						.replace(/\[\[tts(?::[^\]]*?)?\]\]/gi, '')
						.trim() || undefined
			}
		}

		// Fan out to every distinct contributing target
		await this.#deliverPayload(
			payload,
			delivery,
			sessionId,
			runId
		)
	}

	/** Apply auto-TTS to a payload if configured. Non-fatal on error. */
	async #applyAutoTts(
		payload: ChannelReplyPayload,
		inboundAudio: boolean
	): Promise<ChannelReplyPayload> {
		const ttsConfig = this.#getTtsConfig?.()
		if (!ttsConfig || ttsConfig.mode === 'off')
			return payload
		try {
			// Resolve ElevenLabs config with credentials file fallback
			const config = resolveElevenLabsTtsConfig()
			if (!config.apiKey && this.#credentialsPath) {
				config.apiKey =
					await resolveElevenLabsApiKeyAsync(
						this.#credentialsPath
					)
			}
			return await maybeApplyTtsToPayload({
				payload,
				mode: ttsConfig.mode,
				inboundAudio,
				ttsOptions: { preferOpus: true, config }
			})
		} catch (err) {
			console.error(
				'[delivery] Auto-TTS failed, delivering text-only:',
				err
			)
			return payload
		}
	}

	/** Resolve media and deliver a payload to all targets. */
	async #deliverPayload(
		payload: ChannelReplyPayload,
		delivery: PendingDelivery,
		sessionId: string,
		runId: string
	): Promise<void> {
		// Voice notes (audioAsVoice) are sent without caption text
		const caption = payload.audioAsVoice
			? ''
			: (payload.text ?? '')

		for (const target of delivery.targets.values()) {
			const provider = this.#getProvider(target.channelId)
			if (!provider) continue

			try {
				if (
					payload.mediaRefs?.length &&
					typeof provider.sendMedia === 'function'
				) {
					const ref = payload.mediaRefs[0]
					const media = await resolveMedia(ref, {
						localRoots: this.#mediaLocalRoots()
					})
					await provider.sendMedia(target, caption, {
						buffer: media.buffer,
						mimetype: media.mimetype,
						fileName: media.fileName
					})
				} else if (payload.text) {
					await provider.sendMessage(target, payload.text)
				}
				this.#markDelivered(sessionId, runId, target)
			} catch (err) {
				console.error(
					`[delivery] Failed to send reply via ${target.channelId}:`,
					err
				)
			}
		}
	}

	/** Allowed local roots for media resolution. */
	#mediaLocalRoots(): string[] {
		const roots: string[] = []
		if (this.#dataDir) {
			roots.push(path.join(this.#dataDir, 'uploads'))
		}
		// os.tmpdir() for TTS temp files
		roots.push(require('node:os').tmpdir())
		return roots
	}

	#extractFinalAssistantText(
		sessionId: string,
		runId: string
	): string | null {
		const rows = this.#store.queryRunEvents(
			sessionId,
			runId
		)

		const texts: string[] = []
		for (const row of rows) {
			if (row.type !== 'assistant_message') continue
			let parsed: Record<string, unknown>
			try {
				parsed = JSON.parse(row.payload)
			} catch {
				continue
			}
			if (parsed.streaming) continue
			const message = parsed.message as
				| {
						content?: Array<{
							type: string
							text?: string
						}>
				  }
				| undefined
			if (!message?.content) continue
			for (const block of message.content) {
				if (block.type === 'text' && block.text) {
					texts.push(block.text)
				}
			}
		}
		return texts.length > 0 ? texts.join('\n') : null
	}

	/** Extract file paths from completed generate_image tool_execution events. */
	#extractImageGenMedia(
		rows: Array<{
			type: string
			payload: string
		}>
	): string[] {
		const paths: string[] = []
		for (const row of rows) {
			if (row.type !== 'tool_execution') continue
			let parsed: Record<string, unknown>
			try {
				parsed = JSON.parse(row.payload)
			} catch {
				continue
			}
			if (parsed.toolName !== 'generate_image') continue
			if (
				parsed.status !== 'complete' &&
				parsed.status !== 'error'
			)
				continue
			const result = parsed.result as
				| Record<string, unknown>
				| undefined
			const details = result?.details as
				| Record<string, unknown>
				| undefined
			if (!details || details.success !== true) continue
			const filePath = details.filePath as
				| string
				| undefined
			if (filePath) paths.push(filePath)
		}
		return paths
	}

	/** Build a ChannelReplyPayload from run events (text + auto-appended media). */
	#extractFinalReplyPayload(
		sessionId: string,
		runId: string
	): ChannelReplyPayload | null {
		const rows = this.#store.queryRunEvents(
			sessionId,
			runId
		)

		// Extract text from assistant_message events
		const rawText = this.#extractFinalAssistantText(
			sessionId,
			runId
		)

		// Build payload from text (parses MEDIA: directives)
		const payload = rawText
			? buildReplyPayload(rawText)
			: { text: undefined, mediaRefs: undefined }

		// Auto-append image-gen media
		const autoMedia = this.#extractImageGenMedia(rows)

		// Merge: auto-generated refs first, then MEDIA: refs from text, deduplicated
		const allRefs = [...autoMedia]
		const seen = new Set(
			autoMedia.map(r => r.replace(/\/+$/, ''))
		)
		for (const ref of payload.mediaRefs ?? []) {
			const normalized = ref.replace(/\/+$/, '')
			if (!seen.has(normalized)) {
				seen.add(normalized)
				allRefs.push(ref)
			}
		}

		const finalPayload: ChannelReplyPayload = {
			text: payload.text,
			mediaRefs: allRefs.length > 0 ? allRefs : undefined,
			audioAsVoice: payload.audioAsVoice
		}

		// Return null if completely empty
		if (!finalPayload.text && !finalPayload.mediaRefs) {
			return null
		}

		return finalPayload
	}

	/** Persist a channel_delivered marker event (idempotent via dedupeKey). */
	#markDelivered(
		sessionId: string,
		runId: string,
		target: ChannelDeliveryTarget
	): void {
		try {
			this.#store.appendEvent(
				sessionId,
				'channel_delivered',
				{
					channelId: target.channelId,
					accountId: target.accountId,
					conversationId: target.conversationId,
					deliveredAt: Date.now()
				},
				runId,
				`channel_delivered:${runId}:${targetKey(target)}`
			)
		} catch (err) {
			console.warn(
				'[delivery] Failed to persist channel_delivered marker:',
				err
			)
		}
	}

	/**
	 * Recover channel runs that closed but were never delivered
	 * (e.g. server crashed before sendMessage completed).
	 * Safe to call multiple times — delivery markers are idempotent.
	 */
	async recoverUndelivered(
		eventStore: EventStore,
		maxAgeMs = 30 * 60_000
	): Promise<number> {
		const undelivered =
			eventStore.findUndeliveredChannelRuns(maxAgeMs)
		if (undelivered.length === 0) return 0

		console.log(
			`[delivery] Recovering ${undelivered.length} undelivered channel run(s)`
		)

		let recovered = 0
		for (const row of undelivered) {
			try {
				const target: ChannelDeliveryTarget = {
					channelId: row.channelId,
					accountId: row.accountId,
					conversationId: row.conversationId
				}

				const payload = this.#extractFinalReplyPayload(
					row.sessionId,
					row.runId
				)
				if (!payload) {
					console.warn(
						`[delivery] No reply payload for run ${row.runId}, skipping`
					)
					continue
				}

				const provider = this.#getProvider(target.channelId)
				if (!provider) {
					console.warn(
						`[delivery] Provider ${target.channelId} not available, skipping`
					)
					continue
				}

				const recoverCaption = payload.audioAsVoice
					? ''
					: (payload.text ?? '')
				if (
					payload.mediaRefs?.length &&
					typeof provider.sendMedia === 'function'
				) {
					const ref = payload.mediaRefs[0]
					const media = await resolveMedia(ref, {
						localRoots: this.#mediaLocalRoots()
					})
					await provider.sendMedia(target, recoverCaption, {
						buffer: media.buffer,
						mimetype: media.mimetype,
						fileName: media.fileName
					})
				} else if (payload.text) {
					await provider.sendMessage(target, payload.text)
				}
				this.#markDelivered(
					row.sessionId,
					row.runId,
					target
				)
				recovered++
			} catch (err) {
				console.error(
					`[delivery] Recovery failed for run ${row.runId}:`,
					err
				)
			}
		}

		console.log(
			`[delivery] Recovered ${recovered} delivery(ies)`
		)
		return recovered
	}

	shutdown(): void {
		for (const unsub of this.#unsubscribers) unsub()
		this.#unsubscribers.length = 0
		this.#watchedSessions.clear()
		this.#pending.clear()
		this.#pendingByRow.clear()
	}
}
