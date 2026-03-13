import type { StoredChatMessage } from '@/collections/chat-messages'
import {
	Message,
	MessageContent
} from '@/components/ai-elements/message'
import type { ToolResultPart } from '../utils'
import {
	getVisibleParts,
	getVisibleToolParts,
	getSortedArtifactParts,
	hasVisibleContent
} from '../utils/message-utils'
import { MessageHeader } from './message-header'
import { MessageThinking } from './message-thinking'
import { MessagePartsList } from './message-parts-list'
import { MessageToolParts } from './message-tool-parts'
import { MessageArtifactParts } from './message-artifact-parts'

export function ConversationMessageRow({
	message,
	toolItems,
	artifactItems,
	toolResults,
	consumedToolCallIds
}: {
	message: StoredChatMessage
	toolItems?: StoredChatMessage[]
	artifactItems?: StoredChatMessage[]
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
	const visibleToolParts = getVisibleToolParts(
		toolItems ?? [],
		consumedToolCallIds
	)
	const sortedArtifactParts = getSortedArtifactParts(
		artifactItems ?? []
	)

	if (
		!hasVisibleContent(
			message,
			visibleParts,
			visibleToolParts,
			sortedArtifactParts
		)
	)
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
					<MessageArtifactParts
						parts={sortedArtifactParts}
						kind="audio"
					/>
					<MessagePartsList
						visibleParts={visibleParts}
						isStreaming={message.isStreaming}
						hasAudio={hasAudio}
						toolResults={toolResults}
						consumedToolCallIds={consumedToolCallIds}
					/>
					<MessageToolParts
						parts={visibleToolParts}
						toolResults={toolResults}
						consumedToolCallIds={consumedToolCallIds}
					/>
					<MessageArtifactParts
						parts={sortedArtifactParts}
						kind="non-audio"
					/>
				</div>
			</MessageContent>
		</Message>
	)
}
