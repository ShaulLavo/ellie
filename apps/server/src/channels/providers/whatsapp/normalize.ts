/**
 * E.164 phone number normalization and WhatsApp JID conversion utilities.
 * Aligned with openclaw's utils.ts — including LID reverse mapping from auth dir.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

// ── JID → E.164 ─────────────────────────────────────────────────────────

export type JidToE164Options = {
	/** Baileys auth directory to look up LID reverse mappings */
	authDir?: string
}

/**
 * Extract the E.164 phone number from a WhatsApp JID.
 * Handles both @s.whatsapp.net and @lid formats.
 *
 * For @lid JIDs, reads the reverse mapping file that Baileys stores
 * in the auth directory (matching openclaw's jidToE164).
 *
 * Examples:
 *   "15550001111@s.whatsapp.net"   → "+15550001111"
 *   "15550001111:0@s.whatsapp.net" → "+15550001111"  (device suffix)
 *   "118696035008721@lid"          → "+15550001111"  (via reverse mapping)
 *   "12345-67890@g.us"             → null  (group)
 */
export function jidToE164(
	jid: string,
	opts?: JidToE164Options
): string | null {
	// Standard @s.whatsapp.net JID
	const match = jid.match(
		/^(\d+)(?::\d+)?@s\.whatsapp\.net$/
	)
	if (match) {
		return `+${match[1]}`
	}

	// @lid format — look up reverse mapping from auth dir
	const lidMatch = jid.match(
		/^(\d+)(?::\d+)?@(?:hosted\.)?lid$/
	)
	if (lidMatch && opts?.authDir) {
		const lid = lidMatch[1]
		const phone = readLidReverseMapping(lid, opts.authDir)
		if (phone) return phone
		console.log(
			`[whatsapp] LID mapping not found for ${lid} in ${opts.authDir}`
		)
	}

	return null
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
