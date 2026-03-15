export type ToolPolicyConfig =
	| 'all'
	| 'none'
	| { allow?: string[]; deny?: string[] }

export type GroupToolPolicyBySenderConfig = Record<
	string,
	ToolPolicyConfig
>

export interface WhatsAppGroupConfig {
	/** Require @mention to trigger the agent (default: true) */
	requireMention?: boolean
	/** Tool policy for this group (default: all tools) */
	tools?: ToolPolicyConfig
	/** Per-sender tool policy overrides (sender ID/E164/name → policy) */
	toolsBySender?: GroupToolPolicyBySenderConfig
}

type GroupToolPolicySender = {
	senderId?: string | null
	senderE164?: string | null
	senderName?: string | null
}

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
 * Resolution: group toolsBySender → group tools → default toolsBySender → default tools.
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

	const groupSenderPolicy = resolveToolsBySender({
		toolsBySender: groupConfig?.toolsBySender,
		...senderInfo
	})
	if (groupSenderPolicy) return groupSenderPolicy

	if (groupConfig?.tools) return groupConfig.tools

	const defaultSenderPolicy = resolveToolsBySender({
		toolsBySender: defaultConfig?.toolsBySender,
		...senderInfo
	})
	if (defaultSenderPolicy) return defaultSenderPolicy

	if (defaultConfig?.tools) return defaultConfig.tools

	return undefined
}
