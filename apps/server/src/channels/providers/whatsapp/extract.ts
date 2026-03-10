/**
 * Unified message content extraction for WhatsApp inbound pipeline.
 * Matches OpenCLAW's extract.ts — pulls text, media placeholders,
 * context info, mentioned JIDs, reply context, and location data
 * from Baileys WAMessage.message objects.
 */

import {
	jidToE164,
	type JidToE164Options
} from './normalize'
import { parseVcard } from './vcard'

// ── Context info extraction ──────────────────────────────────────────

/** Message types that carry contextInfo */
const CONTEXT_INFO_KEYS = [
	'extendedTextMessage',
	'imageMessage',
	'videoMessage',
	'documentMessage',
	'audioMessage',
	'stickerMessage'
] as const

type ContextInfo = {
	mentionedJid?: string[] | null
	participant?: string | null
	stanzaId?: string | null
	quotedMessage?: Record<string, unknown> | null
}

/**
 * Extract contextInfo from any message type.
 * Checks known message types first, then falls back to iterating all fields.
 */
export function extractContextInfo(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	message: Record<string, any> | null | undefined
): ContextInfo | undefined {
	if (!message) return undefined
	for (const key of CONTEXT_INFO_KEYS) {
		const sub = message[key]
		if (sub?.contextInfo)
			return sub.contextInfo as ContextInfo
	}
	// Fallback: iterate all message fields
	for (const key of Object.keys(message)) {
		const sub = message[key]
		if (
			sub &&
			typeof sub === 'object' &&
			'contextInfo' in sub
		) {
			return sub.contextInfo as ContextInfo
		}
	}
	return undefined
}

// ── Text extraction ──────────────────────────────────────────────────

/**
 * Extract text content from a Baileys message.
 * Handles conversation, extendedText, media captions, and contact placeholders.
 */
export function extractText(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	message: Record<string, any> | null | undefined
): string | null {
	if (!message) return null

	// Direct text message
	if (typeof message.conversation === 'string') {
		return message.conversation
	}

	// Extended text (e.g. with link preview)
	if (message.extendedTextMessage?.text) {
		return message.extendedTextMessage.text
	}

	// Image/video/document with caption
	const caption =
		message.imageMessage?.caption ??
		message.videoMessage?.caption ??
		message.documentMessage?.caption
	if (caption) return caption

	// Contact placeholder (vCard)
	const contactText = extractContactPlaceholder(message)
	if (contactText) return contactText

	return null
}

// ── Media placeholder ────────────────────────────────────────────────

/**
 * When there's no text or caption, return a typed placeholder
 * so the agent knows media was received.
 */
export function extractMediaPlaceholder(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	message: Record<string, any> | null | undefined
): string | undefined {
	if (!message) return undefined
	if (message.imageMessage) return '<media:image>'
	if (message.videoMessage) return '<media:video>'
	if (message.audioMessage) return '<media:audio>'
	if (message.documentMessage) return '<media:document>'
	if (message.stickerMessage) return '<media:sticker>'
	return undefined
}

// ── Mentioned JIDs ───────────────────────────────────────────────────

/**
 * Extract mentioned JIDs from a message's contextInfo, deduped.
 */
export function extractMentionedJids(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	message: Record<string, any> | null | undefined
): string[] | undefined {
	const ctx = extractContextInfo(message)
	const jids = ctx?.mentionedJid
	if (!jids?.length) return undefined
	return [...new Set(jids)]
}

// ── Reply context (quoted-message) ───────────────────────────────────

export type ReplyContext = {
	/** stanzaId of the quoted message */
	id?: string
	/** Text of the quoted message */
	body: string
	/** Who sent the quoted message (JID) */
	sender: string
	/** Participant JID of quoted sender */
	senderJid?: string
	/** Resolved E.164 of quoted sender */
	senderE164?: string
}

/**
 * Extract information about the message being replied to (quoted message).
 * Returns null if this message isn't a reply.
 */
export function describeReplyContext(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	message: Record<string, any> | null | undefined,
	jidOpts?: JidToE164Options
): ReplyContext | null {
	const ctx = extractContextInfo(message)
	if (!ctx?.quotedMessage) return null

	const quoted = ctx.quotedMessage as Record<
		string,
		unknown
	>

	// Extract text from quoted message (reuse extractText + location + media fallback)
	let body =
		extractText(quoted) ??
		formatLocationText(extractLocationData(quoted)) ??
		extractMediaPlaceholder(quoted) ??
		''

	// Truncate if very long
	if (body.length > 500) {
		body = body.slice(0, 500) + '…'
	}

	const senderJid = ctx.participant ?? undefined
	const senderE164 = senderJid
		? (jidToE164(senderJid, jidOpts) ?? undefined)
		: undefined

	return {
		id: ctx.stanzaId ?? undefined,
		body,
		sender: senderE164 ?? senderJid ?? 'unknown',
		senderJid: senderJid ?? undefined,
		senderE164
	}
}

// ── Contact placeholder ──────────────────────────────────────────────

/**
 * Extract contact placeholder text from vCard messages.
 */
function extractContactPlaceholder(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	message: Record<string, any> | null | undefined
): string | undefined {
	if (!message) return undefined

	// Single contact
	if (message.contactMessage) {
		const vcard = message.contactMessage.vcard as
			| string
			| undefined
		const displayName = message.contactMessage
			.displayName as string | undefined
		const parsed = parseVcard(vcard)
		const name = parsed.name ?? displayName ?? 'Unknown'
		const phone = parsed.phones[0]
		return phone
			? `<contact: ${name}, ${phone}>`
			: `<contact: ${name}>`
	}

	// Multiple contacts
	if (message.contactsArrayMessage?.contacts?.length) {
		const contacts = message.contactsArrayMessage
			.contacts as Array<{
			displayName?: string
			vcard?: string
		}>
		if (contacts.length === 1) {
			const c = contacts[0]
			const parsed = parseVcard(c.vcard)
			const name = parsed.name ?? c.displayName ?? 'Unknown'
			const phone = parsed.phones[0]
			return phone
				? `<contact: ${name}, ${phone}>`
				: `<contact: ${name}>`
		}
		const names = contacts.slice(0, 2).map(c => {
			const parsed = parseVcard(c.vcard)
			return parsed.name ?? c.displayName ?? 'Unknown'
		})
		const extra = contacts.length - 2
		const label =
			extra > 0
				? `${names.join(', ')} +${extra} more`
				: names.join(', ')
		return `<contacts: ${label}>`
	}

	return undefined
}

// ── Location extraction ──────────────────────────────────────────────

export type LocationSource = 'pin' | 'place' | 'live'

export type NormalizedLocation = {
	latitude: number
	longitude: number
	accuracy?: number
	name?: string
	address?: string
	isLive?: boolean
	source?: LocationSource
	caption?: string
}

/**
 * Extract location data from a message.
 * Handles locationMessage (pin/place) and liveLocationMessage.
 */
export function extractLocationData(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	message: Record<string, any> | null | undefined
): NormalizedLocation | null {
	if (!message) return null

	// Live location
	if (message.liveLocationMessage) {
		const loc = message.liveLocationMessage
		const lat = loc.degreesLatitude
		const lon = loc.degreesLongitude
		if (typeof lat !== 'number' || typeof lon !== 'number')
			return null
		return {
			latitude: lat,
			longitude: lon,
			accuracy:
				typeof loc.accuracyInMeters === 'number'
					? loc.accuracyInMeters
					: undefined,
			isLive: true,
			source: 'live',
			caption:
				typeof loc.caption === 'string'
					? loc.caption
					: undefined
		}
	}

	// Static location (pin or place)
	if (message.locationMessage) {
		const loc = message.locationMessage
		const lat = loc.degreesLatitude
		const lon = loc.degreesLongitude
		if (typeof lat !== 'number' || typeof lon !== 'number')
			return null

		const name =
			typeof loc.name === 'string' ? loc.name : undefined
		const address =
			typeof loc.address === 'string'
				? loc.address
				: undefined
		const hasPlace = !!(name || address)

		return {
			latitude: lat,
			longitude: lon,
			name,
			address,
			source: hasPlace ? 'place' : 'pin',
			caption:
				typeof loc.caption === 'string'
					? loc.caption
					: undefined
		}
	}

	return null
}

/**
 * Format a NormalizedLocation into human-readable text.
 * Returns null if location is null.
 */
export function formatLocationText(
	location: NormalizedLocation | null
): string | null {
	if (!location) return null

	const coords = `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`

	let line: string

	if (location.isLive) {
		const acc =
			location.accuracy != null
				? ` ±${Math.round(location.accuracy)}m`
				: ''
		line = `🛰 Live location: ${coords}${acc}`
	} else if (location.name && location.address) {
		line = `📍 ${location.name} — ${location.address} (${coords})`
	} else if (location.name) {
		line = `📍 ${location.name} (${coords})`
	} else if (location.address) {
		line = `📍 ${location.address} (${coords})`
	} else {
		line = `📍 ${coords}`
	}

	if (location.caption) {
		line += `\n${location.caption}`
	}

	return line
}
