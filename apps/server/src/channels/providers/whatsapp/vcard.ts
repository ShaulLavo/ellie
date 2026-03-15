/**
 * Minimal vCard parser for WhatsApp contact messages.
 * Extracts name and phone numbers from vCard 3.0/4.0 format.
 */

type ParsedVcard = {
	name?: string
	phones: string[]
}

/**
 * Parse a vCard string and extract name + phone numbers.
 * Handles FN (formatted name), N (structured name), and TEL fields.
 */
export function parseVcard(vcard?: string): ParsedVcard {
	if (!vcard) return { phones: [] }

	const lines = unfoldVcard(vcard)
	let fnName: string | undefined
	let nName: string | undefined
	const phones: string[] = []

	for (const line of lines) {
		// FN (formatted name) — always preferred over N
		const fnMatch = line.match(/^FN[;:](.+)/i)
		if (fnMatch) {
			// FN may have parameters (e.g., FN;CHARSET=UTF-8:Name)
			const raw = fnMatch[1]
			const colonIdx = raw.indexOf(':')
			const value =
				colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw
			fnName = unescapeVcard(value.trim())
		}

		// N (structured name) — fallback: "Last;First;Middle;Prefix;Suffix"
		const nMatch = line.match(/^N[;:](.+)/i)
		if (nMatch && !nName) {
			// Check if the N: line has parameters (e.g., N;CHARSET=UTF-8:Last;First)
			const value = nMatch[1]
			const colonIdx = value.indexOf(':')
			const parts = (
				colonIdx >= 0 ? value.slice(colonIdx + 1) : value
			)
				.split(';')
				.map(s => s.trim())
				.filter(Boolean)
			if (parts.length > 0) {
				nName = unescapeVcard(parts.join(' '))
			}
		}

		// TEL — phone number (various formats)
		const telMatch = line.match(/^TEL[;:](.*)/i)
		if (telMatch) {
			// Value may be after last colon (e.g., "TEL;TYPE=CELL:+15551234567")
			const raw = telMatch[1]
			const colonIdx = raw.lastIndexOf(':')
			const phone = (
				colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw
			).trim()
			if (phone) {
				phones.push(unescapeVcard(phone))
			}
		}
	}

	return { name: fnName ?? nName, phones }
}

/**
 * Unfold vCard lines: lines starting with a space or tab
 * are continuations of the previous line (RFC 6350 §3.2).
 */
function unfoldVcard(vcard: string): string[] {
	const raw = vcard.split(/\r?\n/)
	const lines: string[] = []
	for (const line of raw) {
		if (
			(line.startsWith(' ') || line.startsWith('\t')) &&
			lines.length > 0
		) {
			lines[lines.length - 1] += line.slice(1)
		} else {
			lines.push(line)
		}
	}
	return lines
}

/**
 * Unescape vCard escape sequences.
 */
function unescapeVcard(s: string): string {
	return s
		.replace(/\\n/gi, '\n')
		.replace(/\\,/g, ',')
		.replace(/\\;/g, ';')
		.replace(/\\\\/g, '\\')
}
