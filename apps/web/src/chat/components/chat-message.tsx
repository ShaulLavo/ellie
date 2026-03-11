import { memo } from 'react'
import type { StoredChatMessage } from '@/collections/chat-messages'
import {
	Message,
	MessageContent,
	MessageActions
} from '@/components/ai-elements/message'
import {
	Reasoning,
	ReasoningTrigger,
	ReasoningContent
} from '@/components/ai-elements/reasoning'
import type { ToolResultPart } from '../utils'
import { formatTime } from '../utils'
import { PartRenderer } from './part-renderer'
import { CopyButton } from './copy-button'

export const ChatMessageRow = memo(
	({
		message,
		toolResults,
		consumedToolCallIds
	}: {
		message: StoredChatMessage
		toolResults?: Map<string, ToolResultPart>
		consumedToolCallIds?: Set<string>
	}) => {
		// Memory / system messages render as standalone entries
		if (
			message.sender === 'memory' ||
			message.sender === 'system'
		) {
			return (
				<div className="animate-message-in">
					<div className="flex flex-col gap-2">
						{message.parts.map((part, i) => (
							<PartRenderer
								key={`${part.type}-${i}`}
								part={part}
								toolResults={toolResults}
								consumedToolCallIds={consumedToolCallIds}
							/>
						))}
					</div>
				</div>
			)
		}

		const isUser =
			message.sender === 'human' ||
			message.sender === 'user'

		return (
			<Message
				from={isUser ? 'user' : 'assistant'}
				className="animate-message-in"
			>
				<div className="flex items-baseline gap-1.5 text-[10.5px] text-muted-foreground group-[.is-user]:justify-end">
					{message.sender && (
						<span className="font-medium text-foreground/60">
							{message.sender}
						</span>
					)}
					<span className="text-muted-foreground/50">
						{formatTime(message.timestamp)}
					</span>
				</div>
				<MessageContent>
					<div className="flex flex-col gap-2">
						{message.thinking && (
							<Reasoning
								isStreaming={message.isStreaming}
								defaultOpen={false}
								className="mb-0"
							>
								<ReasoningTrigger className="text-xs" />
								<ReasoningContent className="mt-2 text-xs leading-relaxed">
									{message.thinking}
								</ReasoningContent>
							</Reasoning>
						)}
						{message.parts.map((part, i) => (
							<PartRenderer
								key={`${part.type}-${i}`}
								part={part}
								isStreaming={message.isStreaming}
								toolResults={toolResults}
								consumedToolCallIds={consumedToolCallIds}
							/>
						))}
					</div>
				</MessageContent>
				{message.text && !message.isStreaming && (
					<MessageActions className="opacity-0 group-hover:opacity-100 transition-opacity group-[.is-user]:ml-auto">
						<CopyButton text={message.text} />
					</MessageActions>
				)}
			</Message>
		)
	}
)
