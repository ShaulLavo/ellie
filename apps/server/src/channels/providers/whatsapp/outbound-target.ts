/**
 * Outbound target resolution for WhatsApp.
 * Validates and normalizes a target string before sending.
 * Matches OpenCLAW's resolveWhatsAppOutboundTarget behavior.
 */

import { normalizeWhatsAppTarget } from './normalize'

export type OutboundTargetResult =
	| { ok: true; to: string }
	| { ok: false; error: string }

/**
 * Resolve an outbound target to a validated JID or E.164.
 *
 * - Group JIDs (@g.us) are always allowed (groups managed by group policy).
 * - For 'explicit' mode: allows any normalized target.
 * - For 'implicit'/'heartbeat' mode:
 *     - Wildcard '*' or empty allowFrom → allow any target (OpenCLAW behavior)
 *     - Otherwise validates against normalized allowFrom entries
 */
export function resolveOutboundTarget(params: {
	to: string
	allowFrom?: string[]
	mode?: 'explicit' | 'implicit' | 'heartbeat'
}): OutboundTargetResult {
	const { to, mode = 'explicit' } = params

	const normalized = normalizeWhatsAppTarget(to)
	if (!normalized) {
		return { ok: false, error: 'Invalid WhatsApp target' }
	}

	// Group JIDs always allowed
	if (normalized.endsWith('@g.us')) {
		return { ok: true, to: normalized }
	}

	// Explicit mode — any normalized target
	if (mode === 'explicit') {
		return { ok: true, to: normalized }
	}

	// Implicit/heartbeat mode — validate against allowFrom
	// Matching OpenCLAW: normalize entries and check for wildcard
	const allowListRaw = (params.allowFrom ?? [])
		.map(s => s.trim())
		.filter(Boolean)
	const hasWildcard = allowListRaw.includes('*')
	const allowList = allowListRaw
		.filter(s => s !== '*')
		.map(s => normalizeWhatsAppTarget(s))
		.filter((s): s is string => Boolean(s))

	// Wildcard or empty/unconfigured allowFrom → allow any target
	if (hasWildcard || allowList.length === 0) {
		return { ok: true, to: normalized }
	}

	// Check if normalized target is in allowFrom
	if (allowList.includes(normalized)) {
		return { ok: true, to: normalized }
	}

	return {
		ok: false,
		error: `Target ${normalized} not in allowFrom`
	}
}
