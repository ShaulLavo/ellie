import type { StoredChatMessage } from '@/collections/chat-messages'
import {
	Message,
	MessageContent
} from '@/components/ai-elements/message'
import type { ToolResultPart } from '../utils'
import { getVisibleParts } from '../utils/message-utils'
import { MessageHeader } from './message-header'
import { MessageThinking } from './message-thinking'
import { MessagePartsList } from './message-parts-list'

export function ConversationMessageRow({
	message,
	toolResults,
	consumedToolCallIds
}: {
	message: StoredChatMessage
	toolResults?: Map<string, ToolResultPart>
	consumedToolCallIds?: Set<string>
}) {
	const isUser =
		message.sender === 'human' || message.sender === 'user'
	const visibleParts = getVisibleParts(
		message.parts,
		consumedToolCallIds
	)
	const hasAudio = message.parts.some(
		p => p.type === 'audio'
	)

	if (visibleParts.length === 0 && !message.thinking)
		return null

	return (
		<Message
			from={isUser ? 'user' : 'assistant'}
			className="animate-message-in"
		>
			<MessageHeader
				sender={message.sender}
				timestamp={message.timestamp}
			/>
			<MessageContent>
				<div className="flex flex-col gap-2">
					{message.thinking && (
						<MessageThinking
							thinking={message.thinking}
							isStreaming={message.isStreaming}
						/>
					)}
					<MessagePartsList
						visibleParts={visibleParts}
						isStreaming={message.isStreaming}
						hasAudio={hasAudio}
						toolResults={toolResults}
						consumedToolCallIds={consumedToolCallIds}
					/>
				</div>
			</MessageContent>
		</Message>
	)
}
