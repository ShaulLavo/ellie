import type {
	TimelineItem,
	ToolResultPart
} from '../hooks/use-timeline'
import type { ConnectionState } from '@ellie/schemas/chat'
import { EmptyState } from './empty-state'
import { TimelineItemRow } from './timeline-item-row'

function getTimelineItemKey(item: TimelineItem): string {
	if (item.type === 'assistant-turn') return item.runId
	return item.message.id
}

export function TimelineContent({
	timeline,
	toolResults,
	consumedToolCallIds,
	needsBootstrap,
	connectionState
}: {
	timeline: TimelineItem[]
	toolResults: Map<string, ToolResultPart>
	consumedToolCallIds: Set<string>
	needsBootstrap: boolean
	connectionState: ConnectionState
}) {
	if (timeline.length === 0) {
		return (
			<EmptyState
				needsBootstrap={needsBootstrap}
				connectionState={connectionState}
			/>
		)
	}

	return (
		<>
			{timeline.map(item => (
				<TimelineItemRow
					key={getTimelineItemKey(item)}
					item={item}
					toolResults={toolResults}
					consumedToolCallIds={consumedToolCallIds}
				/>
			))}
		</>
	)
}
