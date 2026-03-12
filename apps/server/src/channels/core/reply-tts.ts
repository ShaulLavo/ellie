import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
	elevenLabsTTS,
	type ElevenLabsTtsConfig,
	type ElevenLabsTtsOverrides
} from '../../lib/tts'
import type { ChannelReplyPayload } from './reply-payload'

export interface TtsPayloadOptions {
	/**
	 * Output format hint.
	 * 'opus' is preferred for WhatsApp voice notes (ptt: true).
	 * 'mp3' is the default fallback.
	 */
	preferOpus?: boolean

	/** ElevenLabs voice ID override */
	voiceId?: string

	/** Pre-resolved TTS config (with API key already resolved from credentials). */
	config?: ElevenLabsTtsConfig

	/** Full ElevenLabs overrides (voice settings, model, etc.). */
	overrides?: ElevenLabsTtsOverrides

	/** Temp directory for writing audio files. Default: os.tmpdir() */
	tmpDir?: string
}

const TEMP_FILE_TTL = 5 * 60_000 // 5 minutes

/**
 * Strip markdown formatting that doesn't make sense when spoken.
 * Preserves the semantic content while removing visual formatting.
 */
export function stripMarkdownForTts(text: string): string {
	let result = text

	// Remove code blocks entirely (not speakable)
	result = result.replace(/```[\s\S]*?```/g, '')

	// Convert [text](url) links → just text
	result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

	// Remove inline code markers but keep content
	result = result.replace(/`([^`]*)`/g, '$1')

	// Remove bold/italic markers: **, __, *, _
	result = result.replace(/\*\*([^*]*)\*\*/g, '$1')
	result = result.replace(/__([^_]*)__/g, '$1')
	result = result.replace(/\*([^*]*)\*/g, '$1')
	result = result.replace(/(?<!\w)_([^_]*)_(?!\w)/g, '$1')

	// Remove header markers but keep text
	result = result.replace(/^#{1,6}\s+/gm, '')

	// Remove horizontal rules
	result = result.replace(/^[-*]{3,}\s*$/gm, '')

	// Remove HTML tags
	result = result.replace(/<[^>]+>/g, '')

	// Collapse multiple whitespace/blank lines
	result = result.replace(/\n{3,}/g, '\n\n')
	result = result.replace(/[ \t]+/g, ' ')

	return result.trim()
}

/**
 * Truncate text to a maximum character length for TTS synthesis.
 * Tries to break at sentence boundaries.
 *
 * OpenCLAW defaults: 1500 chars normal, 4096 max.
 */
export function truncateForTts(
	text: string,
	maxChars: number = 1500
): string {
	if (text.length <= maxChars) return text

	const truncZone = text.slice(0, maxChars)

	// Find last sentence-ending punctuation
	const lastSentence = Math.max(
		truncZone.lastIndexOf('.'),
		truncZone.lastIndexOf('!'),
		truncZone.lastIndexOf('?')
	)
	if (lastSentence > maxChars * 0.3) {
		return text.slice(0, lastSentence + 1) + '...'
	}

	// Fall back to last space
	const lastSpace = truncZone.lastIndexOf(' ')
	if (lastSpace > 0) {
		return text.slice(0, lastSpace) + '...'
	}

	return text.slice(0, maxChars) + '...'
}

/**
 * Synthesize text via TTS and return a ChannelReplyPayload
 * with the audio file as a media reference.
 *
 * Writes the audio to a temp file (matching OpenCLAW pattern)
 * so the normal media-resolver path can pick it up.
 */
export async function synthesizeToPayload(
	text: string,
	options: TtsPayloadOptions = {}
): Promise<ChannelReplyPayload> {
	// 1. Strip markdown
	const clean = stripMarkdownForTts(text)

	// 2. Truncate
	const truncated = truncateForTts(clean)

	// 3. Build overrides
	const overrides: ElevenLabsTtsOverrides = {
		...options.overrides
	}
	if (options.voiceId) overrides.voiceId = options.voiceId
	if (options.preferOpus && !overrides.outputFormat)
		overrides.outputFormat = 'opus_16000'

	// 4. Synthesize
	const synthStart = Date.now()
	const result = await elevenLabsTTS({
		text: truncated,
		config: options.config,
		overrides
	})
	console.info('[tts] Synthesis complete', {
		durationMs: Date.now() - synthStart,
		audioSize: result.audio.length,
		format: result.outputFormat
	})

	// 5. Write to temp file
	const tmpDir = options.tmpDir ?? os.tmpdir()
	const fileName = `ellie-tts-${Date.now()}.${result.extension}`
	const tempPath = path.join(tmpDir, fileName)
	await fs.writeFile(tempPath, new Uint8Array(result.audio))

	// 6. Schedule cleanup
	setTimeout(() => {
		fs.unlink(tempPath).catch(() => {})
	}, TEMP_FILE_TTL)

	// 7. Return payload
	return {
		mediaRefs: [tempPath],
		audioAsVoice: true
	}
}
