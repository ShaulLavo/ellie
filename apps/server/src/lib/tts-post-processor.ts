/**
 * TtsPostProcessor — watches ALL sessions for [[tts]] directives
 * in assistant replies and synthesizes audio server-side.
 *
 * Supports per-reply voice overrides via [[tts:voiceId=xxx speed=1.1]]
 * and persistent default voice preferences from DATA_DIR/tts/preferences.json.
 *
 * Runs after run_closed fires. Produces `assistant_audio` events
 * that both the web frontend (audio player) and channel delivery
 * pipeline (voice note) can consume.
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
 * Matches [[tts]] or [[tts:key=value key2=value2 ...]].
 * Group 1 captures the key=value params (if any).
 */
const TTS_TAG_RE = /\[\[tts(?::([^\]]*))?\]\]/gi

/** Check if text contains any [[tts...]] directive. */
function hasTtsDirective(text: string): boolean {
	TTS_TAG_RE.lastIndex = 0
	return TTS_TAG_RE.test(text)
}

/**
 * Parse voice overrides from a [[tts:...]] directive's param string.
 *
 * Example: "voiceId=pMsXgVXv3BLzUgSXRplE stability=0.4 speed=1.1"
 * Returns: { voiceId: "pMsXgVXv3BLzUgSXRplE", voiceSettings: { stability: 0.4, speed: 1.1 } }
 */
export function parseTtsDirectiveParams(
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

/**
 * Extract all [[tts:...]] directives from text and merge their overrides.
 * If multiple directives exist, later ones win for conflicting keys.
 */
function extractDirectiveOverrides(
	text: string
): ElevenLabsTtsOverrides {
	TTS_TAG_RE.lastIndex = 0
	let merged: ElevenLabsTtsOverrides = {}
	let match: RegExpExecArray | null
	while ((match = TTS_TAG_RE.exec(text)) !== null) {
		const params = parseTtsDirectiveParams(match[1])
		merged = {
			...merged,
			...params,
			voiceSettings: {
				...merged.voiceSettings,
				...params.voiceSettings
			}
		}
	}
	// Clean up empty voiceSettings
	if (
		merged.voiceSettings &&
		Object.keys(merged.voiceSettings).length === 0
	) {
		delete merged.voiceSettings
	}
	return merged
}

export interface TtsPostProcessorOpts {
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
	 * Process a completed run: extract text, detect [[tts]],
	 * synthesize, store audio, append assistant_audio event.
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
		// 1. Extract final assistant text and event IDs from this run
		const { text, eventIds } = this.#extractAssistantText(
			sessionId,
			runId
		)
		if (!text) return

		// 2. Check for [[tts]] or [[tts:...]] tag
		if (!hasTtsDirective(text)) return

		// 3. Extract per-reply overrides from directive params
		const directiveOverrides =
			extractDirectiveOverrides(text)

		console.info(
			'[tts-post-processor] Detected [[tts]] in run',
			{
				runId,
				textLength: text.length,
				hasOverrides:
					Object.keys(directiveOverrides).length > 0
			}
		)

		// 4. Prepare text for synthesis (strip all [[tts...]] tags)
		TTS_TAG_RE.lastIndex = 0
		let ttsText = text.replace(TTS_TAG_RE, '').trim()
		ttsText = stripMarkdownForTts(ttsText)
		ttsText = truncateForTts(ttsText)

		if (ttsText.length < 10) {
			console.debug(
				'[tts-post-processor] Text too short after cleanup, skipping'
			)
			return
		}

		// 5. Resolve TTS config (with credentials file fallback for API key)
		const config =
			this.#ttsConfig ?? resolveElevenLabsTtsConfig()
		if (!config.apiKey && this.#credentialsPath) {
			config.apiKey = await resolveElevenLabsApiKeyAsync(
				this.#credentialsPath
			)
		}

		// 6. Load persistent preferences and merge with directive overrides
		//    Priority: directive overrides > saved preferences > config defaults
		const overrides = await this.#buildOverrides(
			directiveOverrides
		)

		// 7. Synthesize
		const synthStart = Date.now()
		let result
		try {
			result = await elevenLabsTTS({
				text: ttsText,
				config,
				overrides
			})
		} catch (err) {
			console.error(
				'[tts-post-processor] TTS synthesis failed:',
				err
			)
			return
		}

		console.info(
			'[tts-post-processor] Synthesis complete',
			{
				durationMs: Date.now() - synthStart,
				audioSize: result.audio.length,
				format: result.outputFormat,
				voiceId: overrides.voiceId ?? config.voiceId
			}
		)

		// 8. Store audio via blobSink
		const blobRef = await this.#blobSink.write({
			traceId: runId,
			spanId: 'tts-post',
			role: 'tts_output',
			content: result.audio,
			mimeType: result.mime,
			ext: result.extension
		})

		// 9. Append assistant_audio event (deduped by runId)
		this.#store.appendEvent(
			sessionId,
			'assistant_audio',
			{
				uploadId: blobRef.uploadId,
				mime: result.mime,
				size: result.audio.length,
				synthesizedText: ttsText
			},
			runId,
			`tts:${runId}`
		)

		// 10. Clear text from assistant_message events (audio replaces text)
		for (const evtId of eventIds) {
			this.#clearTextFromEvent(evtId, sessionId)
		}
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

	#extractAssistantText(
		sessionId: string,
		runId: string
	): { text: string; eventIds: number[] } {
		const rows = this.#store.queryRunEvents(
			sessionId,
			runId
		)
		const texts: string[] = []
		const eventIds: number[] = []

		for (const row of rows) {
			if (row.type !== 'assistant_message') continue
			let parsed: Record<string, unknown>
			try {
				parsed = JSON.parse(row.payload as string)
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
			eventIds.push(row.id)
		}

		return { text: texts.join('\n'), eventIds }
	}

	#clearTextFromEvent(
		eventId: number,
		sessionId: string
	): void {
		try {
			const rows = this.#store.queryEvents(sessionId)
			const row = rows.find(r => r.id === eventId)
			if (!row) return

			const parsed = JSON.parse(row.payload as string)
			const message = parsed.message as Record<
				string,
				unknown
			>
			if (!message?.content) return

			// Clear all text blocks — the audio event replaces the text
			const content = message.content as Array<{
				type: string
				text?: string
			}>
			for (const block of content) {
				if (block.type === 'text') {
					block.text = ''
				}
			}

			this.#store.updateEvent(eventId, parsed, sessionId)
		} catch (err) {
			console.warn(
				'[tts-post-processor] Failed to clear text from event:',
				err
			)
		}
	}

	shutdown(): void {
		for (const unsub of this.#unsubscribers) unsub()
		this.#unsubscribers.length = 0
		this.#watchedSessions.clear()
	}
}
