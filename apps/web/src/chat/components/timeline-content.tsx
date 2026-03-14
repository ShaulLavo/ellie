import { memo } from 'react'
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

function TimelineContentImpl({
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

export const TimelineContent = memo(
	TimelineContentImpl,
	(prev, next) => {
		const hasMessages =
			prev.timeline.length > 0 && next.timeline.length > 0

		if (!hasMessages) {
			return (
				prev.timeline === next.timeline &&
				prev.toolResults === next.toolResults &&
				prev.consumedToolCallIds ===
					next.consumedToolCallIds &&
				prev.needsBootstrap === next.needsBootstrap &&
				prev.connectionState === next.connectionState
			)
		}

		return (
			prev.timeline === next.timeline &&
			prev.toolResults === next.toolResults &&
			prev.consumedToolCallIds === next.consumedToolCallIds
		)
	}
)
