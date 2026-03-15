import {
	synthesizeToPayload,
	stripMarkdownForTts,
	truncateForTts,
	type TtsPayloadOptions
} from './reply-tts'
import type { ChannelReplyPayload } from './reply-payload'

export type TtsAutoMode =
	| 'off'
	| 'always'
	| 'inbound'
	| 'tagged'

interface AutoTtsContext {
	/** The reply payload to potentially augment with TTS audio */
	payload: ChannelReplyPayload

	/** Current TTS auto mode */
	mode: TtsAutoMode

	/**
	 * Whether the inbound message that triggered this reply
	 * was a voice/audio message (for 'inbound' mode gating).
	 */
	inboundAudio?: boolean

	/**
	 * Maximum text length for TTS synthesis.
	 * Default: 1500.
	 */
	maxTextLength?: number

	/**
	 * Minimum text length to bother with TTS.
	 * Default: 10.
	 */
	minTextLength?: number

	/** TTS synthesis options (voice, format, etc.) */
	ttsOptions?: TtsPayloadOptions
}

export async function maybeApplyTtsToPayload(
	ctx: AutoTtsContext
): Promise<ChannelReplyPayload> {
	const {
		payload,
		mode,
		inboundAudio = false,
		maxTextLength = 1500,
		minTextLength = 10,
		ttsOptions
	} = ctx

	if (mode === 'off') return payload

	if (payload.mediaRefs && payload.mediaRefs.length > 0) {
		return payload
	}

	const text = payload.text
	if (!text) return payload

	if (text.length < minTextLength) {
		return payload
	}

	if (/^MEDIA:/im.test(text)) return payload

	switch (mode) {
		case 'always':
			break

		case 'inbound':
			if (!inboundAudio) {
				return payload
			}
			break

		case 'tagged': {
			if (!/\[\[tts\]\]/i.test(text)) return payload
			break
		}
	}

	let ttsText = text

	ttsText = ttsText
		.replace(/\[\[tts(?::[^\]]*?)?\]\]/gi, '')
		.trim()

	ttsText = stripMarkdownForTts(ttsText)

	ttsText = truncateForTts(ttsText, maxTextLength)

	if (ttsText.length < minTextLength) return payload

	try {
		const ttsPayload = await synthesizeToPayload(ttsText, {
			preferOpus: true, // Prefer opus for WhatsApp voice-note compat
			...ttsOptions
		})

		return {
			...payload,
			// Strip [[tts]] from the display text too
			text:
				payload.text
					?.replace(/\[\[tts(?::[^\]]*?)?\]\]/gi, '')
					.trim() || undefined,
			mediaRefs: ttsPayload.mediaRefs,
			audioAsVoice: ttsPayload.audioAsVoice
		}
	} catch (err) {
		// TTS failure is non-fatal — deliver text as-is
		console.error(
			'[auto-tts] Synthesis failed, delivering text-only:',
			err
		)
		return payload
	}
}
