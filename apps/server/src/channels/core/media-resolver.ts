import { stat, realpath } from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

type MediaKind = 'audio' | 'image' | 'video' | 'document'

interface ResolvedMedia {
	buffer: Buffer
	mimetype: string
	fileName: string
	kind: MediaKind
}

interface MediaResolverOptions {
	/**
	 * Allowed root directories for local file paths.
	 * Refs outside these roots are rejected.
	 * Default: [os.tmpdir()]
	 */
	localRoots?: string[]

	/**
	 * Maximum media size in bytes.
	 * Default: 25 * 1024 * 1024 (25 MB — WhatsApp limit)
	 */
	maxBytes?: number
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024 // 25 MB

const MIME_MAP: Record<string, string> = {
	// Audio
	mp3: 'audio/mpeg',
	opus: 'audio/ogg; codecs=opus',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	flac: 'audio/flac',
	webm: 'audio/webm',

	// Image
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',

	// Video
	mp4: 'video/mp4',
	avi: 'video/x-msvideo',
	mov: 'video/quicktime',

	// Document
	pdf: 'application/pdf',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	txt: 'text/plain'
}

function classifyKind(mimetype: string): MediaKind {
	if (mimetype.startsWith('audio/')) return 'audio'
	if (mimetype.startsWith('image/')) return 'image'
	if (mimetype.startsWith('video/')) return 'video'
	return 'document'
}

/**
 * Resolve a media reference to a buffer + metadata.
 *
 * Supported ref formats:
 *   1. Local file path — must be under one of localRoots
 *   2. (Future: blob/upload refs, URLs — add as needed)
 *
 * Throws on:
 *   - Path outside localRoots (security)
 *   - File not found
 *   - File exceeds maxBytes
 *   - Unsupported/unknown MIME type
 */
export async function resolveMedia(
	ref: string,
	options: MediaResolverOptions = {}
): Promise<ResolvedMedia> {
	const localRoots = options.localRoots ?? [os.tmpdir()]
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

	const resolved = path.resolve(ref)
	const realPath = await realpath(resolved)

	const realRoots = await Promise.all(
		localRoots.map(async root => {
			try {
				return await realpath(root)
			} catch {
				return path.resolve(root)
			}
		})
	)
	const allowed = realRoots.some(root => {
		const normalizedRoot = root.endsWith(path.sep)
			? root
			: root + path.sep
		return (
			realPath === root ||
			realPath.startsWith(normalizedRoot)
		)
	})
	if (!allowed) {
		throw new Error(
			'Media ref rejected: path outside allowed roots'
		)
	}

	const fileStat = await stat(realPath)
	if (fileStat.size > maxBytes) {
		throw new Error(
			`Media ref rejected: file size ${fileStat.size} exceeds limit ${maxBytes}`
		)
	}

	const buffer = Buffer.from(
		await Bun.file(realPath).arrayBuffer()
	)

	const ext = path.extname(realPath).slice(1).toLowerCase()
	const mimetype =
		MIME_MAP[ext] ?? 'application/octet-stream'

	const kind = classifyKind(mimetype)

	return {
		buffer,
		mimetype,
		fileName: path.basename(realPath),
		kind
	}
}
