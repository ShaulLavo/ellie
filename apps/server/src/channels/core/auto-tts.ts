import {
	synthesizeToPayload,
	stripMarkdownForTts,
	truncateForTts,
	type TtsPayloadOptions
} from './reply-tts'
import type { ChannelReplyPayload } from './reply-payload'

/**
 * TTS auto mode — matches OpenCLAW semantics.
 */
export type TtsAutoMode =
	| 'off'
	| 'always'
	| 'inbound'
	| 'tagged'

export interface AutoTtsContext {
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
	 * Default: 1500 (OpenCLAW default).
	 */
	maxTextLength?: number

	/**
	 * Minimum text length to bother with TTS.
	 * Default: 10 (OpenCLAW default).
	 */
	minTextLength?: number

	/** TTS synthesis options (voice, format, etc.) */
	ttsOptions?: TtsPayloadOptions
}

/**
 * Conditionally apply TTS to a reply payload based on mode and context.
 *
 * Matches OpenCLAW's maybeApplyTtsToPayload() behavior:
 * - off: never apply
 * - always: apply to all eligible text replies
 * - inbound: apply only when inbound message was voice/audio
 * - tagged: apply only when [[tts]] directive is present
 *
 * Returns the payload unchanged if TTS is not applied,
 * or a new payload with audio media attached.
 */
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

	// 1. Mode gate
	if (mode === 'off') return payload

	// 2. Skip if payload already has media (don't double-attach)
	if (payload.mediaRefs && payload.mediaRefs.length > 0) {
		console.debug(
			'[auto-tts] Skipped: payload already has media'
		)
		return payload
	}

	// 3. Skip if no text
	const text = payload.text
	if (!text) return payload

	// 4. Skip if text too short
	if (text.length < minTextLength) {
		console.debug('[auto-tts] Skipped: text too short', {
			length: text.length,
			minTextLength
		})
		return payload
	}

	// 5. Skip if text contains MEDIA: (explicit media, not TTS candidate)
	if (/^MEDIA:/im.test(text)) return payload

	// 6. Mode-specific gates
	switch (mode) {
		case 'always':
			break // proceed

		case 'inbound':
			if (!inboundAudio) {
				console.debug(
					'[auto-tts] Skipped: inbound mode but no audio'
				)
				return payload
			}
			break

		case 'tagged': {
			if (!/\[\[tts\]\]/i.test(text)) return payload
			break
		}
	}

	// 7. Prepare text for synthesis
	let ttsText = text

	// Strip [[tts]] tag if present (for 'tagged' mode)
	ttsText = ttsText
		.replace(/\[\[tts(?::[^\]]*?)?\]\]/gi, '')
		.trim()

	// Strip markdown
	ttsText = stripMarkdownForTts(ttsText)

	// Enforce max length
	ttsText = truncateForTts(ttsText, maxTextLength)

	// Skip if nothing left after cleanup
	if (ttsText.length < minTextLength) return payload

	// 8. Synthesize
	console.info('[auto-tts] Applying TTS', {
		mode,
		textLength: ttsText.length
	})
	try {
		const ttsPayload = await synthesizeToPayload(ttsText, {
			preferOpus: true, // Prefer opus for WhatsApp voice-note compat
			...ttsOptions
		})

		// 9. Return merged payload:
		//    - Keep original text (for caption/fallback)
		//    - Add audio media refs
		//    - Set audioAsVoice
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
