type MentionGateResult = {
	shouldProcess: boolean
	effectiveWasMentioned: boolean
}

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
