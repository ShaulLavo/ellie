import type {
	TimelineItem,
	ToolResultPart
} from '../hooks/use-timeline'
import type { ConnectionState } from '@ellie/schemas/chat'
import { EmptyState } from './empty-state'
import { TimelineItemRow } from './timeline-item-row'
import { ConnectionIndicator } from './connection-indicator'

export function TimelineContent({
	timeline,
	toolResults,
	consumedToolCallIds,
	needsBootstrap,
	connectionState,
	connectionError
}: {
	timeline: TimelineItem[]
	toolResults: Map<string, ToolResultPart>
	consumedToolCallIds: Set<string>
	needsBootstrap: boolean
	connectionState: ConnectionState
	connectionError: string | null
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
					key={item.message.id}
					item={item}
					toolResults={toolResults}
					consumedToolCallIds={consumedToolCallIds}
				/>
			))}
			<ConnectionIndicator
				state={connectionState}
				error={connectionError}
			/>
		</>
	)
}
