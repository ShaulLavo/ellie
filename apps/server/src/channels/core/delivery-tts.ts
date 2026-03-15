import type { RealtimeStore } from '../../lib/realtime-store'
import type { ChannelReplyPayload } from './reply-payload'
import type { TtsPostProcessor } from '../../lib/tts-post-processor'
import type { TtsConfig } from './delivery-helpers'
import { toUploadRef } from './delivery-helpers'
import { maybeApplyTtsToPayload } from './auto-tts'
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
	branchId: string,
	runId: string,
	inboundAudio: boolean,
	useRunTtsPostProcessor: boolean,
	deps: DeliveryTtsDeps,
	hasTtsDirective?: boolean,
	assistantRowId?: number
): Promise<ChannelReplyPayload[]> {
	if (hasTtsDirective) {
		return await prepareExplicitTtsPayloads(
			payload,
			useRunTtsPostProcessor,
			runId,
			branchId,
			deps,
			assistantRowId
		)
	}
	const autoTtsPayload = await applyAutoTts(
		payload,
		inboundAudio,
		deps
	)
	return [autoTtsPayload]
}

async function prepareExplicitTtsPayloads(
	payload: ChannelReplyPayload,
	useRunTtsPostProcessor: boolean,
	runId: string,
	branchId: string,
	deps: DeliveryTtsDeps,
	assistantRowId?: number
): Promise<ChannelReplyPayload[]> {
	const basePayload = payload

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
				branchId
			)
			const audioPayload = extractAssistantAudioPayload(
				deps.store,
				branchId,
				runId,
				assistantRowId
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

async function resolveTtsConfig(
	credentialsPath: string | undefined
): Promise<ElevenLabsTtsConfig> {
	const config = resolveElevenLabsTtsConfig()
	if (!config.apiKey && credentialsPath) {
		config.apiKey =
			await resolveElevenLabsApiKeyAsync(credentialsPath)
	}
	return config
}

function extractAssistantAudioPayload(
	store: RealtimeStore,
	branchId: string,
	runId: string,
	assistantRowId?: number
): ChannelReplyPayload | null {
	const rows = store.queryRunEvents(branchId, runId)
	for (const row of rows) {
		if (row.type !== 'assistant_artifact') continue
		let parsed: Record<string, unknown>
		try {
			parsed = JSON.parse(row.payload)
		} catch {
			continue
		}
		if (parsed.kind !== 'audio') continue
		// When assistantRowId is provided, only match the artifact
		// bound to that specific reply (not the first audio in the run).
		if (
			assistantRowId != null &&
			parsed.assistantRowId !== assistantRowId
		) {
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

/** Apply auto-TTS to a payload if configured. Non-fatal on error. */
async function applyAutoTts(
	payload: ChannelReplyPayload,
	inboundAudio: boolean,
	deps: Pick<
		DeliveryTtsDeps,
		'getTtsConfig' | 'credentialsPath'
	>
): Promise<ChannelReplyPayload> {
	const ttsConfig = deps.getTtsConfig?.()
	if (!ttsConfig || ttsConfig.mode === 'off') return payload
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
