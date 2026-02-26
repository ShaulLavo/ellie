interface TypingIndicatorProps {
	typingUsers: string[]
	agentStatus: string
}

export function TypingIndicator({
	typingUsers,
	agentStatus
}: TypingIndicatorProps) {
	const isAgentActive =
		agentStatus === 'thinking' ||
		agentStatus === 'tool-calling'
	const allTyping = [
		...typingUsers,
		...(isAgentActive ? ['Agent'] : [])
	]

	if (allTyping.length === 0) return null

	const label =
		allTyping.length === 1
			? `${allTyping[0]} is typing`
			: allTyping.length === 2
				? `${allTyping[0]} and ${allTyping[1]} are typing`
				: `${allTyping.slice(0, -1).join(', ')} and ${allTyping[allTyping.length - 1]} are typing`

	return (
		<div className="flex items-center gap-2 px-6 py-1.5 text-[11px] text-muted-foreground/70">
			<span className="flex gap-0.5">
				<span className="animate-bounce [animation-delay:0ms]">
					&bull;
				</span>
				<span className="animate-bounce [animation-delay:150ms]">
					&bull;
				</span>
				<span className="animate-bounce [animation-delay:300ms]">
					&bull;
				</span>
			</span>
			<span>{label}</span>
		</div>
	)
}
