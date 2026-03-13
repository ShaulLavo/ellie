import type { StoredChatMessage } from '@/collections/chat-messages'
import type { ToolResultPart } from '../utils'
import { SystemMessageRow } from './system-message-row'
import { ConversationMessageRow } from './conversation-message-row'

export function ChatMessageRow({
	message,
	toolResults,
	consumedToolCallIds
}: {
	message: StoredChatMessage
	toolResults?: Map<string, ToolResultPart>
	consumedToolCallIds?: Set<string>
}) {
	if (
		message.sender === 'memory' ||
		message.sender === 'system'
	) {
		return (
			<SystemMessageRow
				message={message}
				toolResults={toolResults}
				consumedToolCallIds={consumedToolCallIds}
			/>
		)
	}

	return (
		<ConversationMessageRow
			message={message}
			toolResults={toolResults}
			consumedToolCallIds={consumedToolCallIds}
		/>
	)
}
