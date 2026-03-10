/**
 * Per-group configuration resolution.
 * Resolves group-specific settings with wildcard fallback,
 * matching OpenCLAW's group-policy.ts pattern — including
 * per-group/per-sender tool policy resolution.
 */

// ── Tool policy types (matching OpenCLAW's ToolPolicyConfig) ────────────

export type ToolPolicyConfig =
	| 'all'
	| 'none'
	| { allow?: string[]; deny?: string[] }

export type GroupToolPolicyBySenderConfig = Record<
	string,
	ToolPolicyConfig
>

// ── Group config (matching OpenCLAW's ChannelGroupConfig) ───────────────

export interface WhatsAppGroupConfig {
	/** Require @mention to trigger the agent (default: true) */
	requireMention?: boolean
	/** Tool policy for this group (default: all tools) */
	tools?: ToolPolicyConfig
	/** Per-sender tool policy overrides (sender ID/E164/name → policy) */
	toolsBySender?: GroupToolPolicyBySenderConfig
}

// ── Sender identification for tool policy resolution ────────────────────

export type GroupToolPolicySender = {
	senderId?: string | null
	senderE164?: string | null
	senderName?: string | null
}

// ── Resolution functions ────────────────────────────────────────────────

/**
 * Resolve the group config for a specific group JID.
 * Resolution: exact JID match → wildcard "*" → undefined.
 */
export function resolveGroupConfig(
	groups: Record<string, WhatsAppGroupConfig>,
	groupJid: string
): WhatsAppGroupConfig | undefined {
	return groups[groupJid] ?? groups['*']
}

/**
 * Resolve whether a group requires @mention to trigger.
 * Resolution: exact JID → wildcard "*" → true (safe default).
 */
export function resolveRequireMention(
	groups: Record<string, WhatsAppGroupConfig>,
	groupJid: string
): boolean {
	const config = resolveGroupConfig(groups, groupJid)
	return config?.requireMention ?? true
}

// ── Sender key normalization (matching OpenCLAW) ────────────────────────

function normalizeSenderKey(value: string): string {
	const trimmed = value.trim()
	if (!trimmed) return ''
	// Strip leading @ (e.g. @username → username)
	const withoutAt = trimmed.startsWith('@')
		? trimmed.slice(1)
		: trimmed
	return withoutAt.toLowerCase()
}

/**
 * Resolve a tool policy from a per-sender map.
 * Tries each sender identifier in order: senderId → senderE164 → senderName.
 * Falls back to wildcard "*" entry if no specific match.
 * Matching OpenCLAW's resolveToolsBySender.
 */
export function resolveToolsBySender(
	params: {
		toolsBySender?: GroupToolPolicyBySenderConfig
	} & GroupToolPolicySender
): ToolPolicyConfig | undefined {
	const { toolsBySender } = params
	if (!toolsBySender) return undefined

	const entries = Object.entries(toolsBySender)
	if (entries.length === 0) return undefined

	// Build normalized map + extract wildcard
	const normalized = new Map<string, ToolPolicyConfig>()
	let wildcard: ToolPolicyConfig | undefined
	for (const [rawKey, policy] of entries) {
		if (!policy) continue
		const key = normalizeSenderKey(rawKey)
		if (!key) continue
		if (key === '*') {
			wildcard = policy
			continue
		}
		if (!normalized.has(key)) {
			normalized.set(key, policy)
		}
	}

	// Try each sender identifier
	const candidates: string[] = []
	const push = (v?: string | null) => {
		const trimmed = v?.trim()
		if (trimmed) candidates.push(trimmed)
	}
	push(params.senderId)
	push(params.senderE164)
	push(params.senderName)

	for (const candidate of candidates) {
		const key = normalizeSenderKey(candidate)
		if (!key) continue
		const match = normalized.get(key)
		if (match) return match
	}

	return wildcard
}

/**
 * Resolve the tool policy for a group + sender combination.
 * Resolution chain (matching OpenCLAW's resolveChannelGroupToolsPolicy):
 *   1. Group-specific toolsBySender (sender match)
 *   2. Group-specific tools
 *   3. Default ("*") toolsBySender (sender match)
 *   4. Default ("*") tools
 *   5. undefined (no restriction)
 */
export function resolveGroupToolsPolicy(
	params: {
		groups: Record<string, WhatsAppGroupConfig>
		groupJid: string
	} & GroupToolPolicySender
): ToolPolicyConfig | undefined {
	const { groups, groupJid, ...senderInfo } = params

	const groupConfig = groups[groupJid]
	const defaultConfig = groups['*']

	// 1. Group-specific sender policy
	const groupSenderPolicy = resolveToolsBySender({
		toolsBySender: groupConfig?.toolsBySender,
		...senderInfo
	})
	if (groupSenderPolicy) return groupSenderPolicy

	// 2. Group-specific tools
	if (groupConfig?.tools) return groupConfig.tools

	// 3. Default sender policy
	const defaultSenderPolicy = resolveToolsBySender({
		toolsBySender: defaultConfig?.toolsBySender,
		...senderInfo
	})
	if (defaultSenderPolicy) return defaultSenderPolicy

	// 4. Default tools
	if (defaultConfig?.tools) return defaultConfig.tools

	return undefined
}
