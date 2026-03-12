import type { StoredChatMessage } from '@/collections/chat-messages'
import type { ToolResultPart } from '../hooks/use-tool-grouping'
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
	messages,
	toolResults,
	consumedToolCallIds,
	hiddenMessageIds,
	needsBootstrap,
	connectionState,
	connectionError
}: {
	messages: StoredChatMessage[]
	toolResults: Map<string, ToolResultPart>
	consumedToolCallIds: Set<string>
	hiddenMessageIds: Set<string>
	needsBootstrap: boolean
	connectionState: ConnectionState
	connectionError: string | null
}) {
	const isEmpty = messages.length === 0

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
