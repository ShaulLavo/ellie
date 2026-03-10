/**
 * Bot mention detection for WhatsApp group messages.
 * Detects explicit @mentions, reply-to-self (implicit mention),
 * and body text fallback — matching OpenCLAW's isBotMentionedFromTargets.
 */

import {
	jidToE164,
	type JidToE164Options
} from './normalize'

// ── Context info extraction ──────────────────────────────────────────

/** Message types that carry contextInfo (subset of Baileys proto.IMessage) */
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
}

function extractContextInfo(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	message: Record<string, any> | null | undefined
): ContextInfo | undefined {
	if (!message) return undefined
	for (const key of CONTEXT_INFO_KEYS) {
		const sub = message[key]
		if (sub?.contextInfo)
			return sub.contextInfo as ContextInfo
	}
	return undefined
}

/**
 * Extract mentioned JIDs from a Baileys message.
 * Checks contextInfo.mentionedJid across all message types.
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

/**
 * Extract the sender JID of the message being replied to.
 * This is contextInfo.participant from the quoted message.
 */
export function extractReplyToSenderJid(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	message: Record<string, any> | null | undefined
): string | undefined {
	const ctx = extractContextInfo(message)
	return ctx?.participant ?? undefined
}

// ── JID comparison helpers ───────────────────────────────────────────

/**
 * Strip the device suffix from a JID for comparison.
 * "15550001111:0@s.whatsapp.net" → "15550001111@s.whatsapp.net"
 */
function stripDeviceSuffix(jid: string): string {
	return jid.replace(/:\d+@/, '@')
}

// ── Bot mention detection ────────────────────────────────────────────

export type MentionCheckParams = {
	/** JIDs that were @mentioned in the message */
	mentionedJids: string[] | undefined
	/** The bot's own JID (sock.user.id) */
	selfJid: string | null
	/** The bot's own E.164 */
	selfE164: string | null
	/** JID of the sender of the message being replied to */
	replyToSenderJid: string | undefined
	/** Message body text */
	body: string
	/** JID resolution options */
	jidOpts?: JidToE164Options
}

export type MentionCheckResult = {
	wasMentioned: boolean
	/** True when replying to bot's own message */
	implicitMention: boolean
}

/**
 * Check whether the bot was mentioned in a message.
 *
 * Detection logic (matching OpenCLAW):
 * 1. Explicit @mention: mentionedJids contains selfJid (bare) or selfE164
 * 2. Reply-to-self (implicit): replyToSenderJid matches selfJid or E.164
 * 3. Body text fallback: message body contains bot's phone number digits
 */
export function checkBotMention(
	params: MentionCheckParams
): MentionCheckResult {
	const {
		mentionedJids,
		selfJid,
		selfE164,
		replyToSenderJid,
		body,
		jidOpts
	} = params

	let wasMentioned = false
	let implicitMention = false

	const bareSelfJid = selfJid
		? stripDeviceSuffix(selfJid)
		: null

	// 1. Explicit @mention check
	if (mentionedJids?.length && bareSelfJid) {
		for (const jid of mentionedJids) {
			const bareJid = stripDeviceSuffix(jid)
			if (bareJid === bareSelfJid) {
				wasMentioned = true
				break
			}
			if (selfE164) {
				const jidE164 = jidToE164(jid, jidOpts)
				if (jidE164 === selfE164) {
					wasMentioned = true
					break
				}
			}
		}
	}

	// 2. Reply-to-self (implicit mention)
	if (replyToSenderJid && bareSelfJid) {
		const bareReply = stripDeviceSuffix(replyToSenderJid)
		if (bareReply === bareSelfJid) {
			implicitMention = true
		} else if (selfE164) {
			const replyE164 = jidToE164(replyToSenderJid, jidOpts)
			if (replyE164 === selfE164) {
				implicitMention = true
			}
		}
	}

	// 3. Body text fallback — check if body contains bot's phone digits
	if (!wasMentioned && !implicitMention && selfE164) {
		const digits = selfE164.replace(/\D/g, '')
		if (digits && body.includes(digits)) {
			wasMentioned = true
		}
	}

	return { wasMentioned, implicitMention }
}
