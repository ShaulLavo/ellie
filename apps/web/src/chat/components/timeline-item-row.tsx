import type {
	TimelineItem,
	ToolResultPart
} from '../hooks/use-timeline'
import { ChatMessageRow } from './chat-message'

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
		case 'assistant-reply':
			return (
				<ChatMessageRow
					key={item.message.id}
					message={item.message}
					toolItems={item.toolItems}
					artifactItems={item.artifactItems}
					toolResults={toolResults}
					consumedToolCallIds={consumedToolCallIds}
				/>
			)
	}
}
