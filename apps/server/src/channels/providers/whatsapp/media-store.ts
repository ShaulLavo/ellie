/**
 * Inbound media storage for WhatsApp messages.
 * Saves downloaded media buffers to disk with MIME-based extensions.
 */

import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/** Map common MIME types to file extensions */
const MIME_TO_EXT: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'video/mp4': 'mp4',
	'video/3gpp': '3gp',
	'audio/ogg; codecs=opus': 'ogg',
	'audio/ogg': 'ogg',
	'audio/mpeg': 'mp3',
	'audio/mp4': 'm4a',
	'application/pdf': 'pdf',
	'application/octet-stream': 'bin'
}

function mimeToExt(mimetype?: string): string {
	if (!mimetype) return 'bin'
	// Exact match first
	if (MIME_TO_EXT[mimetype]) return MIME_TO_EXT[mimetype]
	// Try base type (e.g. "audio/ogg; codecs=opus" → "audio/ogg")
	const base = mimetype.split(';')[0].trim()
	if (MIME_TO_EXT[base]) return MIME_TO_EXT[base]
	// Extract subtype as extension (e.g. "image/png" → "png")
	const slash = base.indexOf('/')
	if (slash >= 0) return base.slice(slash + 1)
	return 'bin'
}

export type SaveMediaParams = {
	buffer: Buffer
	mimetype?: string
	fileName?: string
	dataDir: string
	/** Max file size in bytes (default: 50 * 1024 * 1024 = 50 MB) */
	maxBytes?: number
}

export type SaveMediaResult = {
	path: string
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 // 50 MB

/**
 * Save an inbound media file to disk.
 * Returns the saved file path, or null if the file exceeds maxBytes.
 *
 * Storage path: dataDir/channels/whatsapp/media/inbound/<timestamp>-<hash>.<ext>
 */
export async function saveInboundMedia(
	params: SaveMediaParams
): Promise<SaveMediaResult | null> {
	const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES

	if (params.buffer.length > maxBytes) {
		return null
	}

	const dir = join(
		params.dataDir,
		'channels',
		'whatsapp',
		'media',
		'inbound'
	)
	mkdirSync(dir, { recursive: true })

	// Use original file name extension if available, otherwise derive from MIME
	let ext: string
	if (params.fileName) {
		const dotIdx = params.fileName.lastIndexOf('.')
		ext =
			dotIdx >= 0
				? params.fileName.slice(dotIdx + 1)
				: mimeToExt(params.mimetype)
	} else {
		ext = mimeToExt(params.mimetype)
	}

	const hash = Bun.hash(params.buffer)
		.toString(16)
		.slice(0, 12)
	const filename = `${Date.now()}-${hash}.${ext}`
	const path = join(dir, filename)

	await Bun.write(path, new Uint8Array(params.buffer))

	return { path }
}
