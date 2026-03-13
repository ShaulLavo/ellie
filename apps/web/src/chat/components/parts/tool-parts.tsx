import type { ContentPart } from '@ellie/schemas/chat'
import { ToolCard } from '@/components/ai-elements/tool'
import type { ToolResultPart } from '../../utils'

type ToolCallPart = Extract<
	ContentPart,
	{ type: 'tool-call' }
>
type ToolResultPartType = Extract<
	ContentPart,
	{ type: 'tool-result' }
>

export function ToolCallPartRenderer({
	part,
	toolResults,
	consumedToolCallIds
}: {
	part: ToolCallPart
	toolResults?: Map<string, ToolResultPart>
	consumedToolCallIds?: Set<string>
}) {
	if (
		part.streaming &&
		part.toolCallId &&
		consumedToolCallIds?.has(part.toolCallId)
	) {
		return null
	}
	const matched = part.toolCallId
		? toolResults?.get(part.toolCallId)
		: undefined
	return (
		<ToolCard
			className="my-1"
			name={part.name}
			args={part.args}
			result={matched?.result}
			elapsedMs={matched?.elapsedMs}
			streaming={part.streaming}
		/>
	)
}

export function ToolResultPartRenderer({
	part
}: {
	part: ToolResultPartType
}) {
	return (
		<ToolCard
			className="my-1"
			name={part.toolName ?? 'Result'}
			args={{}}
			result={part.result}
			elapsedMs={part.elapsedMs}
		/>
	)
}
