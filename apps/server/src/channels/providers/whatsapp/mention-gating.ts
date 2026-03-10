/**
 * Mention gating — decides whether a group message should be processed
 * or stored as context history.
 * Pure function matching OpenCLAW's resolveMentionGating.
 */

export type MentionGateResult = {
	shouldProcess: boolean
	effectiveWasMentioned: boolean
}

/**
 * Resolve whether a group message should trigger the agent.
 *
 * When requireMention is true, the message is only processed if
 * the bot was explicitly @mentioned or implicitly mentioned (reply-to-self).
 * Otherwise, the message is stored as context for the next triggered message.
 */
export function resolveMentionGating(params: {
	requireMention: boolean
	wasMentioned: boolean
	implicitMention: boolean
}): MentionGateResult {
	const effectiveWasMentioned =
		params.wasMentioned || params.implicitMention
	const shouldProcess =
		!params.requireMention || effectiveWasMentioned
	return { shouldProcess, effectiveWasMentioned }
}
