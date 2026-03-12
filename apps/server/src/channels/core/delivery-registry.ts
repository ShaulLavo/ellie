import type { EventRow, EventStore } from '@ellie/db'
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
import {
	synthesizeToPayload,
	stripMarkdownForTts,
	truncateForTts
} from './reply-tts'
import { resolveMedia } from './media-resolver'
import {
	maybeApplyTtsToPayload,
	type TtsAutoMode
} from './auto-tts'
import {
	resolveElevenLabsTtsConfig,
	resolveElevenLabsApiKeyAsync,
	type ElevenLabsTtsConfig,
	type ElevenLabsTtsOverrides
} from '../../lib/tts'
import {
	parseTtsDirectiveParams,
	type TtsPostProcessor
} from '../../lib/tts-post-processor'
import { loadTtsPreferences } from '../../lib/tts-preferences'

/** Check for any [[tts...]] directive in text. */
const TTS_DIRECTIVE_RE = /\[\[tts(?::[^\]]*?)?\]\]/i
const TTS_DIRECTIVE_GLOBAL_RE =
	/\[\[tts(?::([^\]]*?))?\]\]/gi
const UPLOAD_REF_PREFIX = 'upload:'

function toUploadRef(uploadId: string): string {
	return `${UPLOAD_REF_PREFIX}${uploadId}`
}

function extractUploadIdFromMediaRef(
	ref: string
): string | undefined {
	const trimmed = ref.trim()
	const uploadPrefixMatch = trimmed.match(/^upload:(.+)$/i)
	if (uploadPrefixMatch?.[1]) {
		return uploadPrefixMatch[1]
	}

	const uploadContentMatch = trimmed.match(
		/\/api\/uploads-rpc\/([^/?#]+)\/content(?:[?#].*)?$/i
	)
	if (uploadContentMatch?.[1]) {
		try {
			return decodeURIComponent(uploadContentMatch[1])
		} catch {
			return uploadContentMatch[1]
		}
	}

	const uploadsMarker = '/uploads/'
	const uploadsIndex = trimmed.indexOf(uploadsMarker)
	if (uploadsIndex === -1) return undefined
	const uploadId = trimmed.slice(
		uploadsIndex + uploadsMarker.length
	)
	return uploadId.length > 0 ? uploadId : undefined
}

function normalizeMediaRef(ref: string): string {
	const uploadId = extractUploadIdFromMediaRef(ref)
	if (uploadId) return toUploadRef(uploadId)
	return ref.replace(/\/+$/, '')
}

function appendUniqueMediaRef(
	refs: string[],
	seen: Set<string>,
	ref: string | undefined
): void {
	if (!ref) return
	const normalized = normalizeMediaRef(ref)
	if (seen.has(normalized)) return
	seen.add(normalized)
	refs.push(normalized)
}

function extractToolUploadRefs(
	details: Record<string, unknown> | undefined
): string[] {
	if (!details || details.success !== true) return []

	const refs: string[] = []
	const seen = new Set<string>()
	const uploadId =
		typeof details.uploadId === 'string'
			? details.uploadId
			: undefined
	appendUniqueMediaRef(
		refs,
		seen,
		uploadId ? toUploadRef(uploadId) : undefined
	)

	const images = Array.isArray(details.images)
		? details.images
		: []
	for (const image of images) {
		if (!image || typeof image !== 'object') continue
		const imageUploadId = (image as { uploadId?: unknown })
			.uploadId
		if (typeof imageUploadId !== 'string') continue
		appendUniqueMediaRef(
			refs,
			seen,
			toUploadRef(imageUploadId)
		)
	}

	return refs
}

export interface TtsConfig {
	mode: TtsAutoMode
	inboundAudio?: boolean
}

function targetKey(t: ChannelDeliveryTarget): string {
	return `${t.channelId}:${t.accountId}:${t.conversationId}`
}

// ── Outbound item model ─────────────────────────────────────────────────

/** A single atomic send operation with stable identity for checkpointing. */
interface OutboundItem {
	replyIndex: number
	payloadIndex: number
	attachmentIndex: number
	kind: 'message' | 'media' | 'audio_voice'
	/** Caption (media) or message text. */
	text: string
	/** Media ref to resolve and send. */
	mediaRef?: string
}

function checkpointKey(item: {
	replyIndex: number
	payloadIndex: number
	attachmentIndex: number
}): string {
	return `${item.replyIndex}:${item.payloadIndex}:${item.attachmentIndex}`
}

/** Split prepared payloads into individual outbound items. */
function buildOutboundItems(
	replyIndex: number,
	preparedPayloads: ChannelReplyPayload[]
): OutboundItem[] {
	const items: OutboundItem[] = []
	for (const [
		payloadIndex,
		payload
	] of preparedPayloads.entries()) {
		if (payload.mediaRefs?.length) {
			const kind: OutboundItem['kind'] =
				payload.audioAsVoice ? 'audio_voice' : 'media'
			const caption = payload.audioAsVoice
				? ''
				: (payload.text ?? '')
			for (const [ai, ref] of payload.mediaRefs.entries()) {
				items.push({
					replyIndex,
					payloadIndex,
					attachmentIndex: ai,
					kind,
					text: ai === 0 ? caption : '',
					mediaRef: ref
				})
			}
		} else if (payload.text) {
			items.push({
				replyIndex,
				payloadIndex,
				attachmentIndex: 0,
				kind: 'message',
				text: payload.text
			})
		}
	}
	return items
}

// ── Internal state types ────────────────────────────────────────────────

interface PendingDelivery {
	sessionId: string
	targets: Map<string, PendingTargetDelivery>
	inFlight: Promise<void>
}

interface PendingTargetDelivery {
	target: ChannelDeliveryTarget
	/** Checkpoint keys for items already sent (live path). */
	deliveredKeys: Set<string>
	lastComposingAt: number
}

interface PendingRowEntry {
	sessionId: string
	target: ChannelDeliveryTarget
	createdAt: number
}

interface ExtractedReplyPayload {
	assistantRowId: number
	payload: ChannelReplyPayload
	isLastAssistantReply: boolean
}

const PENDING_ROW_TTL = 10 * 60_000 // 10 minutes
const PENDING_ROW_MAX = 500
const COMPOSING_COOLDOWN_MS = 3_000

function parseRowPayload(
	row: Pick<EventRow, 'payload'>
): Record<string, unknown> | null {
	try {
		return JSON.parse(row.payload) as Record<
			string,
			unknown
		>
	} catch {
		return null
	}
}

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
	readonly #store: RealtimeStore
	readonly #getProvider: (
		id: string
	) => ChannelProvider | undefined
	readonly #dataDir?: string
	readonly #credentialsPath?: string
	readonly #getTtsConfig?: () => TtsConfig | undefined
	readonly #watchedSessions = new Set<string>()
	readonly #unsubscribers: Array<() => void> = []
	#ttsPostProcessor?: TtsPostProcessor

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
		this.#credentialsPath = opts.credentialsPath
		this.#getTtsConfig = opts.getTtsConfig
	}

	/** Inject TtsPostProcessor so delivery can await its audio instead of racing. */
	setTtsPostProcessor(tpp: TtsPostProcessor): void {
		this.#ttsPostProcessor = tpp
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
			const current = existing.targets.get(key)
			existing.targets.set(key, {
				target,
				deliveredKeys: current?.deliveredKeys ?? new Set(),
				lastComposingAt: current?.lastComposingAt ?? 0
			})
			return
		}

		this.#pending.set(runId, {
			sessionId,
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
				if (event.type === 'update') {
					this.#promotePendingRow(event.event)
					this.#handleLiveRowEvent(event.event, sessionId)
					return
				}

				if (event.type !== 'append') return
				this.#handleLiveRowEvent(event.event, sessionId)

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

	#promotePendingRow(row: EventRow): void {
		if (!row.runId) return
		const pending = this.#pendingByRow.get(row.id)
		if (!pending) return
		this.#pendingByRow.delete(row.id)
		this.register(
			row.runId,
			pending.sessionId,
			pending.target
		)
	}

	#handleLiveRowEvent(
		row: EventRow,
		sessionId: string
	): void {
		if (!row.runId) return
		if (row.type === 'run_closed') return

		if (row.type === 'tool_execution') {
			this.#sendComposingForRun(row.runId)
			return
		}
		if (row.type !== 'assistant_message') return

		if (!this.#isFinalAssistantMessageRow(row)) {
			this.#sendComposingForRun(row.runId)
			return
		}

		this.#sendComposingForRun(row.runId)
		this.#queueRunDelivery(row.runId, async () => {
			await this.#deliverPendingReplies(
				row.runId!,
				sessionId,
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
		delivery.inFlight = next.catch(err => {
			console.error(
				`[delivery] queued delivery failed for ${runId}:`,
				err
			)
		})
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
				.catch(err => {
					console.warn(
						`[delivery] sendComposing failed for ${targetState.target.channelId}:`,
						err
					)
				})
		}
	}

	async #handleRunClosed(
		runId: string,
		sessionId: string
	): Promise<void> {
		if (!this.#pending.has(runId)) {
			console.log(
				`[delivery] run_closed but not in pending map: runId=${runId} sessionId=${sessionId}`
			)
			return // Not a channel-triggered run
		}
		await this.#queueRunDelivery(runId, async () => {
			await this.#deliverPendingReplies(
				runId,
				sessionId,
				true
			)
		})
		this.#pending.delete(runId)
	}

	async #preparePayloadsForDelivery(
		payload: ChannelReplyPayload,
		sessionId: string,
		runId: string,
		inboundAudio: boolean,
		useRunTtsPostProcessor: boolean
	): Promise<ChannelReplyPayload[]> {
		const textHasTts =
			!!payload.text && TTS_DIRECTIVE_RE.test(payload.text)
		if (textHasTts) {
			return await this.#prepareExplicitTtsPayloads(
				payload,
				useRunTtsPostProcessor,
				runId,
				sessionId
			)
		}
		const autoTtsPayload = await this.#applyAutoTts(
			payload,
			inboundAudio
		)
		return [this.#stripTtsDirectives(autoTtsPayload)]
	}

	async #prepareExplicitTtsPayloads(
		payload: ChannelReplyPayload,
		useRunTtsPostProcessor: boolean,
		runId: string,
		sessionId: string
	): Promise<ChannelReplyPayload[]> {
		const basePayload = this.#stripTtsDirectives(payload)
		if (useRunTtsPostProcessor && this.#ttsPostProcessor) {
			try {
				await this.#ttsPostProcessor.processRun(
					runId,
					sessionId
				)
				const audioPayload =
					this.#extractAssistantAudioPayload(
						sessionId,
						runId
					)
				if (audioPayload) {
					if (basePayload.mediaRefs?.length) {
						return [basePayload, audioPayload]
					}
					return [audioPayload]
				}
				console.warn(
					'[delivery] TtsPostProcessor produced no audio, falling back to direct synthesis',
					{ runId }
				)
			} catch (err) {
				console.error(
					'[delivery] TtsPostProcessor failed, falling back to direct synthesis:',
					err
				)
			}
		}

		try {
			const audioPayload =
				await this.#synthesizeExplicitTtsPayload(
					payload.text
				)
			if (!audioPayload) return [basePayload]
			if (basePayload.mediaRefs?.length) {
				return [basePayload, audioPayload]
			}
			return [audioPayload]
		} catch (err) {
			console.error(
				'[delivery] Explicit TTS synthesis failed, falling back to text:',
				err
			)
			return [basePayload]
		}
	}

	async #synthesizeExplicitTtsPayload(
		text: string | undefined
	): Promise<ChannelReplyPayload | null> {
		if (!text) return null
		const ttsText = this.#toSpeakableTtsText(text)
		if (ttsText.length < 10) return null
		const config = await this.#resolveTtsConfig()
		const overrides =
			await this.#buildExplicitTtsOverrides(text)
		return await synthesizeToPayload(ttsText, {
			preferOpus: true,
			config,
			overrides
		})
	}

	async #resolveTtsConfig(): Promise<ElevenLabsTtsConfig> {
		const config = resolveElevenLabsTtsConfig()
		if (!config.apiKey && this.#credentialsPath) {
			config.apiKey = await resolveElevenLabsApiKeyAsync(
				this.#credentialsPath
			)
		}
		return config
	}

	async #buildExplicitTtsOverrides(
		text: string
	): Promise<ElevenLabsTtsOverrides> {
		const directiveOverrides =
			this.#extractDirectiveOverrides(text)
		if (!this.#dataDir) return directiveOverrides

		const prefs = await loadTtsPreferences(this.#dataDir)
		return {
			...(prefs.voiceId && { voiceId: prefs.voiceId }),
			...(prefs.modelId && { modelId: prefs.modelId }),
			...directiveOverrides,
			voiceSettings: {
				...prefs.voiceSettings,
				...directiveOverrides.voiceSettings
			}
		}
	}

	#extractDirectiveOverrides(
		text: string
	): ElevenLabsTtsOverrides {
		TTS_DIRECTIVE_GLOBAL_RE.lastIndex = 0
		let merged: ElevenLabsTtsOverrides = {}
		let match: RegExpExecArray | null
		while (
			(match = TTS_DIRECTIVE_GLOBAL_RE.exec(text)) !== null
		) {
			const parsed = parseTtsDirectiveParams(match[1])
			merged = {
				...merged,
				...parsed,
				voiceSettings: {
					...merged.voiceSettings,
					...parsed.voiceSettings
				}
			}
		}
		return merged
	}

	#toSpeakableTtsText(text: string): string {
		TTS_DIRECTIVE_GLOBAL_RE.lastIndex = 0
		const withoutDirectives = text
			.replace(TTS_DIRECTIVE_GLOBAL_RE, '')
			.split('\n')
			.filter(line => !/^\s*media:\s*/i.test(line))
			.join('\n')
			.trim()
		return truncateForTts(
			stripMarkdownForTts(withoutDirectives)
		)
	}

	#extractAssistantAudioPayload(
		sessionId: string,
		runId: string
	): ChannelReplyPayload | null {
		const rows = this.#store.queryRunEvents(
			sessionId,
			runId
		)
		for (const row of rows) {
			if (row.type !== 'assistant_audio') continue
			let parsed: Record<string, unknown>
			try {
				parsed = JSON.parse(row.payload)
			} catch {
				continue
			}
			const uploadId = parsed.uploadId as string | undefined
			if (!uploadId) continue
			return {
				text: undefined,
				mediaRefs: [toUploadRef(uploadId)],
				audioAsVoice: true
			}
		}
		return null
	}

	#stripTtsDirectives(
		payload: ChannelReplyPayload
	): ChannelReplyPayload {
		if (!payload.text) return payload
		return {
			...payload,
			text:
				payload.text
					.replace(TTS_DIRECTIVE_GLOBAL_RE, '')
					.trim() || undefined
		}
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
			const config = await this.#resolveTtsConfig()
			return await maybeApplyTtsToPayload({
				payload,
				mode: ttsConfig.mode,
				inboundAudio,
				ttsOptions: { preferOpus: true, config }
			})
		} catch (err) {
			console.warn(
				'[delivery] Auto-TTS failed, delivering text-only:',
				err
			)
			return payload
		}
	}

	// ── Core delivery loop (per-item checkpointing) ──────────────────────

	/**
	 * Heuristic check: is a reply fully delivered based on the raw
	 * (unprepared) payload and the set of already-delivered keys?
	 * Used to skip expensive preparation (TTS synthesis) for items
	 * that were already sent in a prior delivery pass.
	 */
	#isReplyFullyDelivered(
		replyIndex: number,
		rawPayload: ChannelReplyPayload,
		deliveredKeys: Set<string>
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

		// Explicit [[tts]] with media creates a second payload
		if (
			rawPayload.text &&
			TTS_DIRECTIVE_RE.test(rawPayload.text) &&
			rawPayload.mediaRefs?.length
		) {
			if (!deliveredKeys.has(`${replyIndex}:1:0`))
				return false
		}

		return true
	}

	async #deliverPendingReplies(
		runId: string,
		sessionId: string,
		isRunClosed: boolean
	): Promise<void> {
		const delivery = this.#pending.get(runId)
		if (!delivery) return

		const replyPayloads = this.#extractReplyPayloads(
			sessionId,
			runId
		)
		console.log(
			`[delivery] extractReplyPayloads: runId=${runId}`,
			JSON.stringify({
				replyCount: replyPayloads.length,
				isRunClosed
			})
		)
		if (replyPayloads.length === 0) return

		// Cache prepared payloads per reply so TTS is called once
		// and shared across all targets.
		const preparedCache = new Map<
			number,
			ChannelReplyPayload[]
		>()

		for (const targetState of delivery.targets.values()) {
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
							targetState.deliveredKeys
						)
					) {
						continue
					}

					let payloads = preparedCache.get(replyIndex)
					if (!payloads) {
						payloads =
							await this.#preparePayloadsForDelivery(
								reply.payload,
								sessionId,
								runId,
								targetState.target.inboundMediaType?.startsWith(
									'audio/'
								) ?? false,
								isRunClosed && reply.isLastAssistantReply
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
							sessionId,
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
				this.#resolveMediaRef(item.mediaRef),
				{ localRoots: this.#mediaLocalRoots() }
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
		sessionId: string,
		runId: string,
		target: ChannelDeliveryTarget,
		item: OutboundItem,
		assistantRowId: number
	): void {
		try {
			this.#store.appendEvent(
				sessionId,
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
		} catch (err) {
			console.warn(
				'[delivery] Failed to persist checkpoint:',
				err
			)
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

	#resolveMediaRef(ref: string): string {
		const uploadId = extractUploadIdFromMediaRef(ref)
		if (!uploadId) return ref
		if (!this.#dataDir) {
			throw new Error(
				'Cannot resolve upload media without dataDir'
			)
		}
		return path.join(this.#dataDir, 'uploads', uploadId)
	}

	/** Build ordered reply payloads from completed assistant messages in a run. */
	#extractReplyPayloads(
		sessionId: string,
		runId: string
	): ExtractedReplyPayload[] {
		const rows = this.#store.queryRunEvents(
			sessionId,
			runId
		)
		const extracted: Array<{
			assistantRowId: number
			payload: ChannelReplyPayload
		}> = []
		const pendingAutoMedia: string[] = []
		const pendingSeen = new Set<string>()

		for (const row of rows) {
			if (row.type === 'tool_execution') {
				const parsed = parseRowPayload(row)
				if (!parsed) continue
				const result = parsed.result as
					| Record<string, unknown>
					| undefined
				const details = result?.details as
					| Record<string, unknown>
					| undefined
				for (const ref of extractToolUploadRefs(details)) {
					appendUniqueMediaRef(
						pendingAutoMedia,
						pendingSeen,
						ref
					)
				}
				continue
			}

			if (row.type !== 'assistant_message') continue

			const parsed = parseRowPayload(row)
			if (!parsed) continue
			if (parsed.streaming) continue

			const rawText =
				this.#extractAssistantMessageText(parsed)
			const payload = rawText
				? buildReplyPayload(rawText)
				: {
						text: undefined,
						mediaRefs: undefined,
						audioAsVoice: undefined
					}
			const mediaRefs: string[] = []
			const seen = new Set<string>()
			for (const ref of pendingAutoMedia) {
				appendUniqueMediaRef(mediaRefs, seen, ref)
			}
			for (const ref of payload.mediaRefs ?? []) {
				appendUniqueMediaRef(mediaRefs, seen, ref)
			}
			pendingAutoMedia.length = 0
			pendingSeen.clear()

			const replyPayload: ChannelReplyPayload = {
				text: payload.text,
				mediaRefs:
					mediaRefs.length > 0 ? mediaRefs : undefined,
				audioAsVoice: payload.audioAsVoice
			}
			if (!replyPayload.text && !replyPayload.mediaRefs) {
				continue
			}
			extracted.push({
				assistantRowId: row.id,
				payload: replyPayload
			})
		}

		if (pendingAutoMedia.length > 0) {
			if (extracted.length === 0) {
				extracted.push({
					assistantRowId: 0,
					payload: {
						mediaRefs: [...pendingAutoMedia]
					}
				})
			} else {
				const last = extracted.at(-1)!
				const mediaRefs = [
					...(last.payload.mediaRefs ?? [])
				]
				const seen = new Set(
					mediaRefs.map(normalizeMediaRef)
				)
				for (const ref of pendingAutoMedia) {
					appendUniqueMediaRef(mediaRefs, seen, ref)
				}
				last.payload.mediaRefs = mediaRefs
			}
		}

		return extracted.map((entry, index) => ({
			assistantRowId: entry.assistantRowId,
			payload: entry.payload,
			isLastAssistantReply: index === extracted.length - 1
		}))
	}

	#extractAssistantMessageText(
		payload: Record<string, unknown>
	): string | null {
		const message = payload.message as
			| {
					content?: Array<{
						type: string
						text?: string
					}>
			  }
			| undefined
		if (!message?.content) return null
		const texts: string[] = []
		for (const block of message.content) {
			if (block.type === 'text' && block.text) {
				texts.push(block.text)
			}
		}
		if (texts.length === 0) return null
		return texts.join('\n')
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
		const candidates =
			eventStore.findCandidateChannelRuns(maxAgeMs)
		if (candidates.length === 0) return 0

		console.log(
			`[delivery] Evaluating ${candidates.length} candidate channel run(s) for recovery`
		)

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
						row.sessionId,
						row.runId,
						row.channelId,
						row.accountId,
						row.conversationId
					)
				const deliveredKeys = new Set(
					checkpoints.map(c => checkpointKey(c))
				)

				const replyPayloads = this.#extractReplyPayloads(
					row.sessionId,
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
					const payloads =
						await this.#preparePayloadsForDelivery(
							reply.payload,
							row.sessionId,
							row.runId,
							false,
							reply.isLastAssistantReply
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
				if (!provider) {
					console.warn(
						`[delivery] Provider ${target.channelId} not available, skipping`
					)
					continue
				}

				let sentAny = false
				for (const { item, assistantRowId } of remaining) {
					const sent = await this.#sendOutboundItem(
						provider,
						target,
						item
					)
					if (!sent) continue
					this.#persistCheckpoint(
						row.sessionId,
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

		if (recovered > 0) {
			console.log(
				`[delivery] Recovered ${recovered} delivery(ies)`
			)
		}
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
