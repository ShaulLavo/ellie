import type { StoredChatMessage } from '@/chat/types'
import type { ToolResultPart } from '../utils'
import { partHasVisibleOutput } from './part-utils'
import { PartRenderer } from './part-renderer'
import { MessageThinking } from './message-thinking'

export function TurnStep({
	message,
	toolResults,
	consumedToolCallIds
}: {
	message: StoredChatMessage
	toolResults?: Map<string, ToolResultPart>
	consumedToolCallIds?: Set<string>
}) {
	const visibleParts = message.parts.filter(p =>
		partHasVisibleOutput(p, consumedToolCallIds)
	)

	if (visibleParts.length === 0 && !message.thinking)
		return null

	return (
		<>
			{message.thinking && (
				<MessageThinking
					thinking={message.thinking}
					isStreaming={message.isStreaming}
				/>
			)}
			{visibleParts.map((part, i) => (
				<PartRenderer
					key={`${message.id}-${part.type}-${i}`}
					part={part}
					isStreaming={message.isStreaming}
					toolResults={toolResults}
					consumedToolCallIds={consumedToolCallIds}
				/>
			))}
		</>
	)
}
