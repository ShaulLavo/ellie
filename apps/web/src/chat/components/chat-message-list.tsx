import type { StoredChatMessage } from '@/collections/chat-messages'
import type { ToolResultPart } from '../hooks/use-tool-grouping'
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton
} from '@/components/ai-elements/conversation'
import { ChatMessageRow } from './chat-message'
import { EmptyState } from './empty-state'

export function ChatMessageList({
	messages,
	streamingMessage,
	toolResults,
	consumedToolCallIds,
	hiddenMessageIds,
	needsBootstrap
}: {
	messages: StoredChatMessage[]
	streamingMessage: StoredChatMessage | null
	toolResults: Map<string, ToolResultPart>
	consumedToolCallIds: Set<string>
	hiddenMessageIds: Set<string>
	needsBootstrap: boolean
}) {
	const isEmpty = messages.length === 0 && !streamingMessage

	return (
		<Conversation className="flex-1">
			<ConversationContent className="gap-5 px-6 py-5">
				{isEmpty ? (
					<EmptyState needsBootstrap={needsBootstrap} />
				) : (
					<>
						{messages.map(msg =>
							hiddenMessageIds.has(msg.id) ? null : (
								<ChatMessageRow
									key={msg.id}
									message={msg}
									toolResults={toolResults}
									consumedToolCallIds={consumedToolCallIds}
								/>
							)
						)}
						{streamingMessage &&
							!hiddenMessageIds.has(
								streamingMessage.id
							) && (
								<ChatMessageRow
									key={streamingMessage.id}
									message={streamingMessage}
									toolResults={toolResults}
									consumedToolCallIds={consumedToolCallIds}
								/>
							)}
					</>
				)}
			</ConversationContent>
			<ConversationScrollButton />
		</Conversation>
	)
}
