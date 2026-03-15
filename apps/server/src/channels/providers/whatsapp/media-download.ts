/**
 * Inbound media download for WhatsApp messages.
 * Wraps Baileys' downloadMediaMessage with MIME type resolution.
 */

import {
	downloadMediaMessage,
	type WAMessage
} from '@whiskeysockets/baileys'

/** Known media message types and their default MIME types */
const MEDIA_DEFAULTS: Record<string, string> = {
	imageMessage: 'image/jpeg',
	videoMessage: 'video/mp4',
	audioMessage: 'audio/ogg; codecs=opus',
	stickerMessage: 'image/webp',
	documentMessage: 'application/octet-stream'
}

const MEDIA_KEYS = Object.keys(MEDIA_DEFAULTS)

type DownloadedMedia = {
	buffer: Buffer
	mimetype: string
	fileName?: string
}

/**
 * Download media from an inbound WhatsApp message.
 * Returns the buffer, MIME type, and optional file name.
 * Returns undefined if the message has no media.
 */
export async function downloadInboundMedia(
	msg: WAMessage
): Promise<DownloadedMedia | undefined> {
	const message = msg.message
	if (!message) return undefined

	// Find which media key exists
	let mediaKey: string | undefined
	for (const key of MEDIA_KEYS) {
		if ((message as Record<string, unknown>)[key]) {
			mediaKey = key
			break
		}
	}
	if (!mediaKey) return undefined

	const mediaMsg = (message as Record<string, unknown>)[
		mediaKey
	] as Record<string, unknown>

	// Resolve MIME type: explicit from message, or fall back to defaults
	const mimetype =
		(typeof mediaMsg.mimetype === 'string'
			? mediaMsg.mimetype
			: undefined) ?? MEDIA_DEFAULTS[mediaKey]

	// File name (documents usually have this)
	const fileName =
		typeof mediaMsg.fileName === 'string'
			? mediaMsg.fileName
			: undefined

	const buffer = (await downloadMediaMessage(
		msg,
		'buffer',
		{}
	)) as Buffer

	return { buffer, mimetype, fileName }
}
