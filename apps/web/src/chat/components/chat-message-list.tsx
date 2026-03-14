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
import { useChatScrollLock } from '../hooks/use-chat-scroll-lock'

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
	const {
		scrollRef,
		contentRef,
		showScrollButton,
		scrollToBottom
	} = useChatScrollLock()

	return (
		<div className="relative flex flex-1 min-h-0 flex-col overflow-hidden">
			<Conversation
				ref={scrollRef}
				className="flex-1 min-h-0"
			>
				<ConversationContent
					ref={contentRef}
					className="gap-2 px-6 py-5"
				>
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
			</Conversation>
			<ConversationScrollButton
				show={showScrollButton}
				onScrollToBottom={() => scrollToBottom('smooth')}
			/>
		</div>
	)
}
