import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WHATSAPP_USER_JID_RE =
	/^(\d+)(?::\d+)?@s\.whatsapp\.net$/i
const WHATSAPP_LID_RE = /^(\d+)(?::\d+)?@lid$/i
const WHATSAPP_HOSTED_LID_RE =
	/^(\d+)(?::\d+)?@hosted\.lid$/i
const WHATSAPP_HOSTED_RE = /^(\d+)(?::\d+)?@hosted$/i

/** Normalize a phone number to E.164 format. */
export function normalizeE164(number: string): string {
	const withoutPrefix = number
		.replace(/^whatsapp:/, '')
		.trim()
	const digits = withoutPrefix.replace(/[^\d+]/g, '')
	if (digits.startsWith('+')) {
		return `+${digits.slice(1)}`
	}
	return `+${digits}`
}

/** Convert an E.164 phone number to a WhatsApp user JID. */
export function toWhatsAppJid(number: string): string {
	const withoutPrefix = number
		.replace(/^whatsapp:/, '')
		.trim()
	if (withoutPrefix.includes('@')) {
		return withoutPrefix
	}
	const e164 = normalizeE164(withoutPrefix)
	const digits = e164.replace(/\D/g, '')
	return `${digits}@s.whatsapp.net`
}

/** Read a LID->phone reverse mapping file written by Baileys' LIDMappingStore. */
function readLidReverseMapping(
	lid: string,
	authDir: string
): string | null {
	const filename = `lid-mapping-${lid}_reverse.json`
	try {
		const data = readFileSync(
			join(authDir, filename),
			'utf8'
		)
		const phone = JSON.parse(data) as string | number | null
		if (phone == null) return null
		return normalizeE164(String(phone))
	} catch {
		return null
	}
}

function stripWhatsAppPrefixes(value: string): string {
	let candidate = value.trim()
	for (;;) {
		const before = candidate
		candidate = candidate.replace(/^whatsapp:/i, '').trim()
		if (candidate === before) return candidate
	}
}

export type JidToE164Options = {
	authDir?: string
}

/** Extract E.164 from a WhatsApp JID. Returns null for group JIDs. */
export function jidToE164(
	jid: string,
	opts?: JidToE164Options
): string | null {
	const match = jid.match(WHATSAPP_USER_JID_RE)
	if (match) {
		return `+${match[1]}`
	}

	const hostedMatch = jid.match(WHATSAPP_HOSTED_RE)
	if (hostedMatch) {
		return `+${hostedMatch[1]}`
	}

	// For LID JIDs, try reverse mapping first, fall back to raw digits
	const lidMatch = jid.match(WHATSAPP_LID_RE)
	if (lidMatch) {
		const lid = lidMatch[1]
		if (opts?.authDir) {
			const phone = readLidReverseMapping(lid, opts.authDir)
			if (phone) return phone
		}
		return `+${lid}`
	}

	const hostedLidMatch = jid.match(WHATSAPP_HOSTED_LID_RE)
	if (hostedLidMatch) {
		const lid = hostedLidMatch[1]
		if (opts?.authDir) {
			const phone = readLidReverseMapping(lid, opts.authDir)
			if (phone) return phone
		}
		return `+${lid}`
	}

	return null
}

/** Resolve a participant JID to E.164, falling back to the raw JID. */
export function resolveParticipantJid(
	jid: string,
	opts?: JidToE164Options
): string {
	return jidToE164(jid, opts) ?? jid
}

/** Read the bot's own identity from Baileys auth creds. */
export function readSelfId(authDir: string): {
	e164: string | null
	jid: string | null
} {
	try {
		const credsPath = join(authDir, 'creds.json')
		const creds = JSON.parse(
			readFileSync(credsPath, 'utf8')
		)
		const meId = creds?.me?.id as string | undefined
		if (!meId) return { e164: null, jid: meId ?? null }
		const e164 = jidToE164(meId, { authDir })
		return { e164, jid: meId }
	} catch {
		return { e164: null, jid: null }
	}
}

/** Check if a value is a WhatsApp group JID. */
export function isWhatsAppGroupJid(value: string): boolean {
	const candidate = stripWhatsAppPrefixes(value)
	const lower = candidate.toLowerCase()
	if (!lower.endsWith('@g.us')) return false
	const localPart = candidate.slice(
		0,
		candidate.length - '@g.us'.length
	)
	if (!localPart || localPart.includes('@')) return false
	return /^[0-9]+(-[0-9]+)*$/.test(localPart)
}

/** Check if a value looks like a WhatsApp user JID. */
export function isWhatsAppUserTarget(
	value: string
): boolean {
	const candidate = stripWhatsAppPrefixes(value)
	return (
		WHATSAPP_USER_JID_RE.test(candidate) ||
		WHATSAPP_LID_RE.test(candidate) ||
		WHATSAPP_HOSTED_LID_RE.test(candidate) ||
		WHATSAPP_HOSTED_RE.test(candidate)
	)
}

/** Extract the phone number digits from any supported user JID format. */
function extractUserJidPhone(jid: string): string | null {
	for (const re of [
		WHATSAPP_USER_JID_RE,
		WHATSAPP_LID_RE,
		WHATSAPP_HOSTED_LID_RE,
		WHATSAPP_HOSTED_RE
	]) {
		const m = jid.match(re)
		if (m) return m[1]
	}
	return null
}

/** Normalize a raw WhatsApp target to a validated JID or E.164. Returns null if unrecognizable. */
export function normalizeWhatsAppTarget(
	value: string
): string | null {
	const candidate = stripWhatsAppPrefixes(value)
	if (!candidate) return null

	if (isWhatsAppGroupJid(candidate)) {
		const localPart = candidate.slice(
			0,
			candidate.length - '@g.us'.length
		)
		return `${localPart}@g.us`
	}

	if (isWhatsAppUserTarget(candidate)) {
		const phone = extractUserJidPhone(candidate)
		if (!phone) return null
		const e164 = normalizeE164(phone)
		return e164.length > 1 ? e164 : null
	}

	// Reject unknown @ formats
	if (candidate.includes('@')) return null

	// Bare phone -> E.164
	const e164 = normalizeE164(candidate)
	return e164.length > 1 ? e164 : null
}

/** Check if a JID is a Linked ID (LID) format. */
export function isLidJid(jid: string): boolean {
	return /^(\d+)(?::\d+)?@(?:hosted\.)?lid$/.test(jid)
}

/** Extract the base LID number from a LID JID, stripping the device suffix. */
export function lidBaseNumber(jid: string): string | null {
	const match = jid.match(
		/^(\d+)(?::\d+)?@(?:hosted\.)?lid$/
	)
	return match ? match[1] : null
}
