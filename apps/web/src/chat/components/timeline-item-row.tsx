import type {
	TimelineItem,
	ToolResultPart
} from '../hooks/use-timeline'
import { ChatMessageRow } from './chat-message'
import { AssistantTurnRow } from './assistant-turn-row'

export function TimelineItemRow({
	item,
	toolResults,
	consumedToolCallIds
}: {
	item: TimelineItem
	toolResults: Map<string, ToolResultPart>
	consumedToolCallIds: Set<string>
}) {
	switch (item.type) {
		case 'user':
		case 'system':
			return (
				<ChatMessageRow
					key={item.message.id}
					message={item.message}
					toolResults={toolResults}
					consumedToolCallIds={consumedToolCallIds}
				/>
			)
		case 'assistant-turn':
			return (
				<AssistantTurnRow
					key={item.finalMessage.id}
					finalMessage={item.finalMessage}
					steps={item.steps}
					toolResults={toolResults}
					consumedToolCallIds={consumedToolCallIds}
				/>
			)
	}
}
