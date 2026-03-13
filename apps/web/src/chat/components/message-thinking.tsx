import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger
} from '@/components/ai-elements/reasoning'

export function MessageThinking({
	thinking,
	isStreaming
}: {
	thinking: string
	isStreaming?: boolean
}) {
	return (
		<Reasoning
			isStreaming={isStreaming}
			defaultOpen={false}
			className="mb-0"
		>
			<ReasoningTrigger className="text-xs" />
			<ReasoningContent className="mt-2 text-xs leading-relaxed">
				{thinking}
			</ReasoningContent>
		</Reasoning>
	)
}
