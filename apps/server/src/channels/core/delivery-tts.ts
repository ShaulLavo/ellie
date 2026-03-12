import type { RealtimeStore } from '../../lib/realtime-store'
import type { ChannelReplyPayload } from './reply-payload'
import type { TtsPostProcessor } from '../../lib/tts-post-processor'
import type { TtsConfig } from './delivery-helpers'
import {
	TTS_DIRECTIVE_RE,
	TTS_DIRECTIVE_GLOBAL_RE,
	toUploadRef
} from './delivery-helpers'
import {
	maybeApplyTtsToPayload,
} from './auto-tts'
import {
	resolveElevenLabsTtsConfig,
	resolveElevenLabsApiKeyAsync,
	type ElevenLabsTtsConfig
} from '../../lib/tts'

export interface DeliveryTtsDeps {
	credentialsPath?: string
	getTtsConfig?: () => TtsConfig | undefined
	ttsPostProcessor?: TtsPostProcessor
	store: RealtimeStore
}

export async function preparePayloadsForDelivery(
	payload: ChannelReplyPayload,
	sessionId: string,
	runId: string,
	inboundAudio: boolean,
	useRunTtsPostProcessor: boolean,
	deps: DeliveryTtsDeps
): Promise<ChannelReplyPayload[]> {
	const textHasTts =
		!!payload.text && TTS_DIRECTIVE_RE.test(payload.text)
	if (textHasTts) {
		return await prepareExplicitTtsPayloads(
			payload,
			useRunTtsPostProcessor,
			runId,
			sessionId,
			deps
		)
	}
	const autoTtsPayload = await applyAutoTts(
		payload,
		inboundAudio,
		deps
	)
	return [stripTtsDirectives(autoTtsPayload)]
}

export async function prepareExplicitTtsPayloads(
	payload: ChannelReplyPayload,
	useRunTtsPostProcessor: boolean,
	runId: string,
	sessionId: string,
	deps: DeliveryTtsDeps
): Promise<ChannelReplyPayload[]> {
	const basePayload = stripTtsDirectives(payload)

	// During live delivery (before run_closed), defer [[tts]] messages
	// so they are handled once by the TtsPostProcessor at run_closed.
	// This avoids a duplicate ElevenLabs call and the race where a
	// text fallback marks the reply as "fully delivered" before the
	// post-processor has a chance to synthesize audio.
	if (!useRunTtsPostProcessor) {
		return []
	}

	if (deps.ttsPostProcessor) {
		try {
			await deps.ttsPostProcessor.processRun(
				runId,
				sessionId
			)
			const audioPayload =
				extractAssistantAudioPayload(
					deps.store,
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
				'[delivery] TtsPostProcessor produced no audio, delivering text only',
				{ runId }
			)
		} catch (err) {
			console.error(
				'[delivery] TtsPostProcessor failed, delivering text only:',
				err
			)
		}
	}

	return [basePayload]
}

export async function resolveTtsConfig(
	credentialsPath: string | undefined
): Promise<ElevenLabsTtsConfig> {
	const config = resolveElevenLabsTtsConfig()
	if (!config.apiKey && credentialsPath) {
		config.apiKey = await resolveElevenLabsApiKeyAsync(
			credentialsPath
		)
	}
	return config
}

export function extractAssistantAudioPayload(
	store: RealtimeStore,
	sessionId: string,
	runId: string
): ChannelReplyPayload | null {
	const rows = store.queryRunEvents(sessionId, runId)
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

export function stripTtsDirectives(
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
export async function applyAutoTts(
	payload: ChannelReplyPayload,
	inboundAudio: boolean,
	deps: Pick<DeliveryTtsDeps, 'getTtsConfig' | 'credentialsPath'>
): Promise<ChannelReplyPayload> {
	const ttsConfig = deps.getTtsConfig?.()
	if (!ttsConfig || ttsConfig.mode === 'off')
		return payload
	try {
		const config = await resolveTtsConfig(
			deps.credentialsPath
		)
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
