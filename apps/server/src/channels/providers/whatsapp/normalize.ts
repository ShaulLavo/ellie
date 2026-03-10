/**
 * E.164 phone number normalization and WhatsApp JID conversion utilities.
 * Aligned with openclaw's normalize.ts + utils.ts — including LID handling
 * and @hosted user JIDs.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── JID patterns (matching OpenCLAW) ─────────────────────────────────────

const WHATSAPP_USER_JID_RE =
	/^(\d+)(?::\d+)?@s\.whatsapp\.net$/i
const WHATSAPP_LID_RE = /^(\d+)(?::\d+)?@lid$/i
const WHATSAPP_HOSTED_LID_RE =
	/^(\d+)(?::\d+)?@hosted\.lid$/i
const WHATSAPP_HOSTED_RE = /^(\d+)(?::\d+)?@hosted$/i

/**
 * Normalize a phone number to E.164 format.
 * Strips spaces, parens, dashes, and ensures a leading `+`.
 *
 * Examples:
 *   "15550001111"       → "+15550001111"
 *   "+1 (555) 000-1111" → "+15550001111"
 *   "whatsapp:+1555..."  → "+15550001111"
 */
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

/**
 * Convert an E.164 phone number to a WhatsApp user JID.
 *
 * Examples:
 *   "+15550001111" → "15550001111@s.whatsapp.net"
 *   "15550001111"  → "15550001111@s.whatsapp.net"
 */
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

// ── LID reverse mapping (matching openclaw's readLidReverseMapping) ──────

/**
 * Read a LID→phone reverse mapping file from the auth directory.
 * Baileys' useMultiFileAuthState + LIDMappingStore writes these as
 * `lid-mapping-{lid}_reverse.json` containing the phone number digits.
 */
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

// ── Prefix stripping (matching OpenCLAW) ─────────────────────────────────

function stripWhatsAppPrefixes(value: string): string {
	let candidate = value.trim()
	for (;;) {
		const before = candidate
		candidate = candidate.replace(/^whatsapp:/i, '').trim()
		if (candidate === before) return candidate
	}
}

// ── JID → E.164 ─────────────────────────────────────────────────────────

export type JidToE164Options = {
	/** Baileys auth directory to look up LID reverse mappings */
	authDir?: string
}

/**
 * Extract the E.164 phone number from a WhatsApp JID.
 * Handles @s.whatsapp.net, @hosted, @lid, and @hosted.lid formats.
 *
 * For @lid JIDs, reads the reverse mapping file that Baileys stores
 * in the auth directory. Falls back to using the LID digits as E.164
 * when no mapping exists (async LID fallback, matching OpenCLAW).
 *
 * Returns null for group JIDs (@g.us) — callers use remoteJid directly
 * for group routing, so this is intentional.
 *
 * Examples:
 *   "15550001111@s.whatsapp.net"      → "+15550001111"
 *   "15550001111:0@s.whatsapp.net"    → "+15550001111"  (device suffix)
 *   "15550001111@hosted"              → "+15550001111"  (hosted user)
 *   "15550001111:0@hosted"            → "+15550001111"  (hosted user with device suffix)
 *   "118696035008721@lid"             → "+15550001111"  (via reverse mapping)
 *   "118696035008721@lid"             → "+118696035008721"  (LID fallback — no mapping)
 *   "118696035008721:5@hosted.lid"    → "+15550001111"  (hosted LID with device suffix)
 *   "12345-67890@g.us"                → null  (group — intentional)
 */
export function jidToE164(
	jid: string,
	opts?: JidToE164Options
): string | null {
	// Standard @s.whatsapp.net JID
	const match = jid.match(WHATSAPP_USER_JID_RE)
	if (match) {
		return `+${match[1]}`
	}

	// @hosted user JID (same format, hosted domain)
	const hostedMatch = jid.match(WHATSAPP_HOSTED_RE)
	if (hostedMatch) {
		return `+${hostedMatch[1]}`
	}

	// @lid format — try reverse mapping first, fall back to raw digits
	const lidMatch = jid.match(WHATSAPP_LID_RE)
	if (lidMatch) {
		const lid = lidMatch[1]
		if (opts?.authDir) {
			const phone = readLidReverseMapping(lid, opts.authDir)
			if (phone) return phone
		}
		// LID fallback: use LID digits as E.164 when no reverse mapping
		return `+${lid}`
	}

	// @hosted.lid format — try reverse mapping first, fall back to raw digits
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

/**
 * Resolve a participant JID to E.164, falling back to the raw JID.
 * Useful for extracting senderId from msg.key.participant in group messages.
 */
export function resolveParticipantJid(
	jid: string,
	opts?: JidToE164Options
): string {
	return jidToE164(jid, opts) ?? jid
}

/**
 * Read the bot's own identity from Baileys auth creds.
 * creds.me.id is typically "15551234567:0@s.whatsapp.net" or a LID.
 */
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

/**
 * Check if a value is a WhatsApp group JID.
 */
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

/**
 * Check if value looks like a WhatsApp user target
 * (e.g. "41796666864:0@s.whatsapp.net", "123@lid", "123@hosted").
 */
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

/**
 * Extract the phone number from a WhatsApp user JID.
 * Works for @s.whatsapp.net, @lid, @hosted.lid, and @hosted.
 */
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

/**
 * Normalize a raw WhatsApp target string into a validated JID or E.164.
 * Returns null if the format is unrecognizable.
 *
 * Matches OpenCLAW's normalizeWhatsAppTarget — user JIDs (including @lid
 * and @hosted) are normalized to E.164, group JIDs are preserved as-is.
 */
export function normalizeWhatsAppTarget(
	value: string
): string | null {
	const candidate = stripWhatsAppPrefixes(value)
	if (!candidate) return null

	// Group JID
	if (isWhatsAppGroupJid(candidate)) {
		const localPart = candidate.slice(
			0,
			candidate.length - '@g.us'.length
		)
		return `${localPart}@g.us`
	}

	// User JID (any supported format) → E.164
	if (isWhatsAppUserTarget(candidate)) {
		const phone = extractUserJidPhone(candidate)
		if (!phone) return null
		const e164 = normalizeE164(phone)
		return e164.length > 1 ? e164 : null
	}

	// Reject unknown @ formats
	if (candidate.includes('@')) return null

	// Bare phone → E.164
	const e164 = normalizeE164(candidate)
	return e164.length > 1 ? e164 : null
}

/**
 * Check if a JID is a Linked ID (LID) format.
 */
export function isLidJid(jid: string): boolean {
	return /^(\d+)(?::\d+)?@(?:hosted\.)?lid$/.test(jid)
}

/**
 * Extract the base LID number from a LID JID, stripping the device suffix.
 * Returns null if not a LID JID.
 */
export function lidBaseNumber(jid: string): string | null {
	const match = jid.match(
		/^(\d+)(?::\d+)?@(?:hosted\.)?lid$/
	)
	return match ? match[1] : null
}
