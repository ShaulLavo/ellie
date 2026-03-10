/**
 * Inbound access control for WhatsApp messages.
 * Extracted from provider.ts inline logic, aligned with openclaw's access-control.ts.
 *
 * Pure-ish function — only side effects are pairing persistence and sending the reply.
 */

import { normalizeE164 } from './normalize'
import { upsertPairingRequest } from './pairing-store'
import { mergedAllowFrom } from './allowfrom-store'
import { buildPairingReply } from './pairing-messages'
import type { WhatsAppSettings } from './provider'

export type AccessControlResult = {
	allowed: boolean
	shouldMarkRead: boolean
	isSelfChat: boolean
}

const PAIRING_REPLY_HISTORY_GRACE_MS = 30_000

/**
 * Determine if self-chat mode is active.
 * True when the explicit selfChatMode flag is set, OR when the owner's own
 * E.164 is present in allowFrom (openclaw-style inference).
 */
function isSelfChatMode(
	selfE164: string | null,
	settings: WhatsAppSettings
): boolean {
	if (settings.selfChatMode) return true
	if (!selfE164) return false
	const norm = normalizeE164(selfE164)
	return settings.allowFrom.some(
		n => n !== '*' && normalizeE164(n) === norm
	)
}

/**
 * Check whether the sender's E.164 matches the bot's own phone number.
 */
function isSamePhone(
	selfE164: string | null,
	senderE164: string | null
): boolean {
	if (!selfE164 || !senderE164) return false
	return (
		normalizeE164(selfE164) === normalizeE164(senderE164)
	)
}

export async function checkInboundAccessControl(params: {
	settings: WhatsAppSettings
	selfE164: string | null
	senderE164: string | null
	isGroup: boolean
	pushName?: string
	isFromMe: boolean
	messageTimestampMs?: number
	connectedAtMs?: number
	remoteJid: string
	sendPairingReply: (text: string) => Promise<void>
	dataDir?: string
	accountId?: string
}): Promise<AccessControlResult> {
	const {
		settings,
		selfE164,
		senderE164,
		isGroup,
		isFromMe,
		messageTimestampMs,
		connectedAtMs,
		sendPairingReply,
		dataDir,
		accountId
	} = params

	const blocked: AccessControlResult = {
		allowed: false,
		shouldMarkRead: false,
		isSelfChat: false
	}

	// ── Group messages ────────────────────────────────────────────────
	if (isGroup) {
		if (settings.groupPolicy === 'disabled') return blocked

		if (settings.groupPolicy === 'open') {
			return {
				allowed: true,
				shouldMarkRead: true,
				isSelfChat: false
			}
		}

		// groupPolicy === 'allowlist'
		const groupList = settings.groupAllowFrom ?? []
		if (groupList.length === 0) return blocked
		if (groupList.includes('*')) {
			return {
				allowed: true,
				shouldMarkRead: true,
				isSelfChat: false
			}
		}
		if (!senderE164) return blocked
		const normalized = normalizeE164(senderE164)
		const allowed = groupList.some(
			n => normalizeE164(n) === normalized
		)
		return {
			allowed,
			shouldMarkRead: allowed,
			isSelfChat: false
		}
	}

	// ── DM messages ───────────────────────────────────────────────────

	// Outgoing echo on non-self account — block
	if (isFromMe && !isSamePhone(selfE164, senderE164))
		return blocked

	if (settings.dmPolicy === 'disabled') return blocked

	if (settings.dmPolicy === 'open') {
		return {
			allowed: true,
			shouldMarkRead: true,
			isSelfChat: false
		}
	}

	// Self-chat detection
	const selfChat =
		isSelfChatMode(selfE164, settings) &&
		isSamePhone(selfE164, senderE164)

	if (selfChat) {
		return {
			allowed: true,
			shouldMarkRead: false,
			isSelfChat: true
		}
	}

	// Check merged allowFrom (config + runtime store)
	const allowList =
		dataDir && accountId
			? mergedAllowFrom(
					settings.allowFrom,
					dataDir,
					accountId
				)
			: settings.allowFrom

	if (allowList.includes('*')) {
		return {
			allowed: true,
			shouldMarkRead: true,
			isSelfChat: false
		}
	}

	if (senderE164) {
		const normalized = normalizeE164(senderE164)
		const inList = allowList.some(
			n => n !== '*' && normalizeE164(n) === normalized
		)
		if (inList) {
			return {
				allowed: true,
				shouldMarkRead: true,
				isSelfChat: false
			}
		}
	}

	// ── Pairing flow ──────────────────────────────────────────────────
	if (settings.dmPolicy === 'pairing') {
		if (!senderE164) return blocked

		// Grace period: suppress pairing reply for historical messages
		const suppressReply =
			typeof connectedAtMs === 'number' &&
			typeof messageTimestampMs === 'number' &&
			messageTimestampMs <
				connectedAtMs - PAIRING_REPLY_HISTORY_GRACE_MS

		if (suppressReply) return blocked

		if (dataDir && accountId) {
			const { code, created } = upsertPairingRequest({
				dataDir,
				accountId,
				senderId: normalizeE164(senderE164),
				meta: params.pushName
					? { name: params.pushName }
					: undefined
			})

			if (created) {
				const reply = buildPairingReply({
					senderE164: normalizeE164(senderE164),
					code
				})
				await sendPairingReply(reply).catch(() => {})
			}
		}

		return blocked
	}

	// dmPolicy === 'allowlist' — not in list, block silently
	return blocked
}
