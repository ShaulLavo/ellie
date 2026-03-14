import type { ToolResultPart } from '../hooks/use-timeline'
import type { ConnectionState } from '@ellie/schemas/chat'
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton
} from '@/components/ai-elements/conversation'
import { TimelineContent } from './timeline-content'
import type { TimelineItem } from '../hooks/use-timeline'
import { ConnectionIndicator } from './connection-indicator'

export function ChatMessageList({
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
	return (
		<Conversation className="flex-1">
			<ConversationContent className="gap-2 px-6 py-5">
				<TimelineContent
					timeline={timeline}
					toolResults={toolResults}
					consumedToolCallIds={consumedToolCallIds}
					needsBootstrap={needsBootstrap}
					connectionState={connectionState}
				/>
				<ConnectionIndicator
					state={connectionState}
					error={connectionError}
				/>
			</ConversationContent>
			<ConversationScrollButton />
		</Conversation>
	)
}
