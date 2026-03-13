import type {
	TimelineItem,
	ToolResultPart
} from '../hooks/use-timeline'
import type { ConnectionState } from '@ellie/schemas/chat'
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton
} from '@/components/ai-elements/conversation'
import { ChatMessageRow } from './chat-message'
import { ConnectionIndicator } from './connection-indicator'
import { EmptyState } from './empty-state'

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
	const isEmpty = timeline.length === 0

	return (
		<Conversation className="flex-1">
			<ConversationContent className="gap-2 px-6 py-5">
				{isEmpty ? (
					<EmptyState
						needsBootstrap={needsBootstrap}
						connectionState={connectionState}
					/>
				) : (
					<>
						{timeline.map(item => {
							switch (item.type) {
								case 'user':
								case 'system':
									return (
										<ChatMessageRow
											key={item.message.id}
											message={item.message}
											toolResults={toolResults}
											consumedToolCallIds={
												consumedToolCallIds
											}
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
											consumedToolCallIds={
												consumedToolCallIds
											}
										/>
									)
							}
						})}
						<ConnectionIndicator
							state={connectionState}
							error={connectionError}
						/>
					</>
				)}
			</ConversationContent>
			<ConversationScrollButton />
		</Conversation>
	)
}
