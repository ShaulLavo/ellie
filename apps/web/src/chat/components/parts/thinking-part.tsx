import type { ContentPart } from '@ellie/schemas/chat'
import {
	Reasoning,
	ReasoningTrigger,
	ReasoningContent
} from '@/components/ai-elements/reasoning'

type ThinkingPart = Extract<
	ContentPart,
	{ type: 'thinking' }
>

export function ThinkingPartRenderer({
	part
}: {
	part: ThinkingPart
}) {
	return (
		<Reasoning defaultOpen={false} className="mb-0">
			<ReasoningTrigger className="text-xs" />
			<ReasoningContent className="mt-2 text-xs leading-relaxed">
				{part.text}
			</ReasoningContent>
		</Reasoning>
	)
}
