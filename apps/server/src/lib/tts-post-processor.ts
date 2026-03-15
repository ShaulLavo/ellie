/**
 * TtsPostProcessor — watches ALL sessions for ttsDirective flags
 * on assistant replies and synthesizes audio server-side.
 *
 * Supports per-reply voice overrides via [[tts:voiceId=xxx speed=1.1]]
 * (captured as structured ttsDirective at message_end) and persistent
 * default voice preferences from DATA_DIR/tts/preferences.json.
 *
 * Runs after run_closed fires. Produces `assistant_artifact` events
 * (kind='audio', origin='tts') that both the web frontend (audio player)
 * and channel delivery pipeline (voice note) can consume.
 *
 * Processes EVERY reply in a run that has ttsDirective set, not just the last.
 */

import type {
	RealtimeStore,
	SessionEvent
} from './realtime-store'
import type { BlobSink } from '@ellie/trace'
import {
	elevenLabsTTS,
	resolveElevenLabsTtsConfig,
	resolveElevenLabsApiKeyAsync,
	isValidVoiceId,
	type ElevenLabsTtsConfig,
	type ElevenLabsTtsOverrides
} from './tts'
import { loadTtsPreferences } from './tts-preferences'
import {
	stripMarkdownForTts,
	truncateForTts
} from '../channels/core/reply-tts'

/**
 * Parse voice overrides from a [[tts:...]] directive's param string.
 *
 * Example: "voiceId=pMsXgVXv3BLzUgSXRplE stability=0.4 speed=1.1"
 * Returns: { voiceId: "pMsXgVXv3BLzUgSXRplE", voiceSettings: { stability: 0.4, speed: 1.1 } }
 */
function parseTtsDirectiveParams(
	paramStr: string | undefined
): ElevenLabsTtsOverrides {
	if (!paramStr?.trim()) return {}

	const overrides: ElevenLabsTtsOverrides = {}
	const voiceSettings: Record<string, number | boolean> = {}

	// Split on whitespace, parse key=value pairs
	for (const token of paramStr.trim().split(/\s+/)) {
		const eqIdx = token.indexOf('=')
		if (eqIdx < 1) continue
		const key = token.slice(0, eqIdx)
		const val = token.slice(eqIdx + 1)
		if (!val) continue

		switch (key) {
			case 'voiceId':
				if (isValidVoiceId(val)) overrides.voiceId = val
				break
			case 'modelId':
				overrides.modelId = val
				break
			case 'stability': {
				const n = Number(val)
				if (Number.isFinite(n) && n >= 0 && n <= 1)
					voiceSettings.stability = n
				break
			}
			case 'similarityBoost': {
				const n = Number(val)
				if (Number.isFinite(n) && n >= 0 && n <= 1)
					voiceSettings.similarityBoost = n
				break
			}
			case 'style': {
				const n = Number(val)
				if (Number.isFinite(n) && n >= 0 && n <= 1)
					voiceSettings.style = n
				break
			}
			case 'speed': {
				const n = Number(val)
				if (Number.isFinite(n) && n >= 0.5 && n <= 2)
					voiceSettings.speed = n
				break
			}
			case 'useSpeakerBoost':
				voiceSettings.useSpeakerBoost =
					val.toLowerCase() === 'true'
				break
		}
	}

	if (Object.keys(voiceSettings).length > 0) {
		overrides.voiceSettings =
			voiceSettings as ElevenLabsTtsOverrides['voiceSettings']
	}
	return overrides
}

interface TtsPostProcessorOpts {
	store: RealtimeStore
	blobSink: BlobSink
	/** Optional pre-resolved TTS config */
	ttsConfig?: ElevenLabsTtsConfig
	/** Path to credentials file for API key lookup */
	credentialsPath?: string
	/** Data directory for loading TTS preferences */
	dataDir?: string
}

export class TtsPostProcessor {
	readonly #store: RealtimeStore
	readonly #blobSink: BlobSink
	readonly #ttsConfig?: ElevenLabsTtsConfig
	readonly #credentialsPath?: string
	readonly #dataDir?: string
	readonly #inflight = new Map<string, Promise<void>>()
	readonly #watchedSessions = new Set<string>()
	readonly #unsubscribers: Array<() => void> = []

	constructor(opts: TtsPostProcessorOpts) {
		this.#store = opts.store
		this.#blobSink = opts.blobSink
		this.#ttsConfig = opts.ttsConfig
		this.#credentialsPath = opts.credentialsPath
		this.#dataDir = opts.dataDir
	}

	/** Subscribe to a session's events. Idempotent per sessionId. */
	watchSession(sessionId: string): void {
		if (this.#watchedSessions.has(sessionId)) return
		this.#watchedSessions.add(sessionId)

		const unsub = this.#store.subscribeToSession(
			sessionId,
			(event: SessionEvent) => {
				if (event.type !== 'append') return
				if (event.event.type !== 'run_closed') return
				const runId = event.event.runId
				if (!runId) return
				this.#processRun(runId, sessionId).catch(err => {
					console.error(
						'[tts-post-processor] processRun failed:',
						err
					)
				})
			}
		)
		this.#unsubscribers.push(unsub)
	}

	/**
	 * Process a completed run: find all replies with ttsDirective,
	 * synthesize audio for each, emit assistant_artifact events.
	 *
	 * Returns a promise that external callers (e.g. delivery registry)
	 * can await to ensure synthesis is complete before delivering.
	 */
	processRun(
		runId: string,
		sessionId: string
	): Promise<void> {
		return this.#processRun(runId, sessionId)
	}

	async #processRun(
		runId: string,
		sessionId: string
	): Promise<void> {
		// Dedup: if already in-flight for this runId, return existing promise
		const existing = this.#inflight.get(runId)
		if (existing) return existing

		const promise = this.#doProcess(
			runId,
			sessionId
		).finally(() => {
			this.#inflight.delete(runId)
		})
		this.#inflight.set(runId, promise)
		return promise
	}

	async #doProcess(
		runId: string,
		sessionId: string
	): Promise<void> {
		// 1. Query all run events and find replies with ttsDirective
		const rows = this.#store.queryRunEvents(
			sessionId,
			runId
		)

		const ttsReplies: Array<{
			rowId: number
			text: string
			params?: string
		}> = []

		for (const row of rows) {
			if (row.type !== 'assistant_message') continue
			let parsed: Record<string, unknown>
			try {
				parsed = JSON.parse(row.payload as string)
			} catch {
				continue
			}
			if (parsed.streaming) continue

			const ttsDirective = parsed.ttsDirective as
				| { params?: string }
				| undefined
			if (!ttsDirective) continue

			// Extract clean text from stored message
			const message = parsed.message as
				| {
						content?: Array<{
							type: string
							text?: string
						}>
				  }
				| undefined
			if (!message?.content) continue
			const texts: string[] = []
			for (const block of message.content) {
				if (block.type === 'text' && block.text) {
					texts.push(block.text)
				}
			}
			if (texts.length === 0) continue
			const text = texts.join('\n')

			ttsReplies.push({
				rowId: row.id,
				text,
				params: ttsDirective.params
			})
		}

		if (ttsReplies.length === 0) return

		console.info(
			'[tts-post-processor] Found ttsDirective replies in run',
			{
				runId,
				count: ttsReplies.length
			}
		)

		// 2. Resolve TTS config once for all replies
		const config =
			this.#ttsConfig ?? resolveElevenLabsTtsConfig()
		if (!config.apiKey && this.#credentialsPath) {
			config.apiKey = await resolveElevenLabsApiKeyAsync(
				this.#credentialsPath
			)
		}

		// 3. Process each reply
		for (const reply of ttsReplies) {
			try {
				await this.#synthesizeReply(
					reply,
					config,
					sessionId,
					runId
				)
			} catch (err) {
				console.error(
					`[tts-post-processor] Failed to synthesize reply ${reply.rowId}:`,
					err
				)
			}
		}
	}

	async #synthesizeReply(
		reply: { rowId: number; text: string; params?: string },
		config: ElevenLabsTtsConfig,
		sessionId: string,
		runId: string
	): Promise<void> {
		// Parse directive overrides
		const directiveOverrides = parseTtsDirectiveParams(
			reply.params
		)

		// Prepare text for synthesis
		let ttsText = stripMarkdownForTts(reply.text)
		ttsText = truncateForTts(ttsText)

		if (ttsText.length < 10) {
			console.debug(
				`[tts-post-processor] Text too short for reply ${reply.rowId}, skipping`
			)
			return
		}

		// Build overrides (directive > preferences > config defaults)
		const overrides = await this.#buildOverrides(
			directiveOverrides
		)

		// Synthesize
		const synthStart = Date.now()
		const result = await elevenLabsTTS({
			text: ttsText,
			config,
			overrides
		})

		console.info(
			'[tts-post-processor] Synthesis complete',
			{
				rowId: reply.rowId,
				durationMs: Date.now() - synthStart,
				audioSize: result.audio.length,
				format: result.outputFormat,
				voiceId: overrides.voiceId ?? config.voiceId
			}
		)

		// Store audio via blobSink
		const blobRef = await this.#blobSink.write({
			traceId: runId,
			spanId: 'tts-post',
			role: 'tts_output',
			content: result.audio,
			mimeType: result.mime,
			ext: result.extension
		})

		// Emit assistant_artifact event (deduped by assistantRowId)
		this.#store.appendEvent(
			sessionId,
			'assistant_artifact',
			{
				assistantRowId: reply.rowId,
				kind: 'audio' as const,
				origin: 'tts' as const,
				uploadId: blobRef.uploadId,
				url: blobRef.url,
				mimeType: result.mime,
				size: result.audio.length,
				synthesizedText: ttsText
			},
			runId,
			`tts:${reply.rowId}`
		)
	}

	/**
	 * Build overrides by merging saved preferences with per-reply directive overrides.
	 * Directive overrides take priority over saved preferences.
	 */
	async #buildOverrides(
		directiveOverrides: ElevenLabsTtsOverrides
	): Promise<ElevenLabsTtsOverrides> {
		// Load saved preferences
		let prefsOverrides: ElevenLabsTtsOverrides = {}
		if (this.#dataDir) {
			try {
				const prefs = await loadTtsPreferences(
					this.#dataDir
				)
				prefsOverrides = {
					...(prefs.voiceId && {
						voiceId: prefs.voiceId
					}),
					...(prefs.modelId && {
						modelId: prefs.modelId
					}),
					...(prefs.voiceSettings && {
						voiceSettings: prefs.voiceSettings
					})
				}
			} catch {
				// Non-fatal — use config defaults
			}
		}

		// Merge: directive wins over preferences
		return {
			...prefsOverrides,
			...directiveOverrides,
			voiceSettings: {
				...prefsOverrides.voiceSettings,
				...directiveOverrides.voiceSettings
			}
		}
	}

	shutdown(): void {
		for (const unsub of this.#unsubscribers) unsub()
		this.#unsubscribers.length = 0
		this.#watchedSessions.clear()
	}
}
