/**
 * Channel-agnostic reply payload.
 * Produced at delivery time from assistant_message text.
 * Consumed by provider.sendMessage() or provider.sendMedia().
 */
export interface ChannelReplyPayload {
	/** Plain text body (may be empty if media-only) */
	text?: string

	/**
	 * Resolved media references.
	 * Each entry is a local temp-file path or a blob/upload ref.
	 * Phase 3 (media-resolver) turns these into buffers.
	 */
	mediaRefs?: string[]

	/**
	 * When true, audio media should be sent as a voice note
	 * (WhatsApp: ptt=true, Telegram: sendVoice).
	 */
	audioAsVoice?: boolean
}

interface DirectiveParseResult {
	/** Text with directive tokens removed */
	text: string
	/** Extracted media references (file paths / URLs) */
	mediaRefs: string[]
	/** Whether [[audio_as_voice]] was present */
	audioAsVoice: boolean
}

const MEDIA_RE = /^\s*media:\s*/i
const AUDIO_TAG_TEST_RE = /\[\[audio_as_voice\]\]/i
const AUDIO_TAG_REPLACE_RE = /\[\[audio_as_voice\]\]/gi
const FENCE_RE = /^\s*```/

/**
 * Parse MEDIA: and [[audio_as_voice]] directives from raw assistant text.
 *
 * Grammar:
 *   MEDIA:<path-or-upload-ref>      → adds to mediaRefs
 *   [[audio_as_voice]]              → sets audioAsVoice = true
 *
 * Directives inside fenced code blocks (``` ... ```) are ignored.
 */
export function parseReplyDirectives(
	raw: string
): DirectiveParseResult {
	const lines = raw.split('\n')
	const mediaRefs: string[] = []
	let audioAsVoice = false
	const outputLines: string[] = []
	let inFence = false

	for (const line of lines) {
		if (FENCE_RE.test(line)) {
			inFence = !inFence
			outputLines.push(line)
			continue
		}

		if (inFence) {
			outputLines.push(line)
			continue
		}

		// Check for MEDIA: directive
		if (MEDIA_RE.test(line)) {
			let ref = line.replace(MEDIA_RE, '').trim()
			// Support quoted refs
			if (
				ref.length >= 2 &&
				ref.startsWith('"') &&
				ref.endsWith('"')
			) {
				ref = ref.slice(1, -1)
			}
			if (ref) {
				mediaRefs.push(ref)
			}
			continue // remove this line from output
		}

		// Check for [[audio_as_voice]] tag
		if (AUDIO_TAG_TEST_RE.test(line)) {
			audioAsVoice = true
			const cleaned = line
				.replace(AUDIO_TAG_REPLACE_RE, '')
				.trim()
			if (cleaned) {
				outputLines.push(cleaned)
			}
			continue
		}

		outputLines.push(line)
	}

	// Collapse multiple blank lines into one
	const collapsed: string[] = []
	let prevBlank = false
	for (const line of outputLines) {
		const isBlank = line.trim() === ''
		if (isBlank && prevBlank) continue
		collapsed.push(line)
		prevBlank = isBlank
	}

	const text = collapsed.join('\n').trim()

	return { text, mediaRefs, audioAsVoice }
}

/**
 * Build a ChannelReplyPayload from raw assistant text.
 * Runs directive parsing, returns the normalized payload.
 */
export function buildReplyPayload(
	rawText: string
): ChannelReplyPayload {
	const parsed = parseReplyDirectives(rawText)
	return {
		text: parsed.text || undefined,
		mediaRefs:
			parsed.mediaRefs.length > 0
				? parsed.mediaRefs
				: undefined,
		audioAsVoice: parsed.audioAsVoice || undefined
	}
}
