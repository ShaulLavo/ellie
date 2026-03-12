import type { StoredChatMessage } from '@/collections/chat-messages'
import {
	Message,
	MessageContent
} from '@/components/ai-elements/message'
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger
} from '@/components/ai-elements/reasoning'
import { memo } from 'react'
import type { ToolResultPart } from '../utils'
import { formatTime } from '../utils'
import { PartRenderer } from './part-renderer'
import { partHasVisibleOutput } from './part-utils'

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
		const visibleParts = message.parts
			.filter(part =>
				partHasVisibleOutput(part, consumedToolCallIds)
			)
			.sort((a, b) => {
				// Audio parts render before text transcriptions
				if (a.type === 'audio' && b.type !== 'audio')
					return -1
				if (a.type !== 'audio' && b.type === 'audio')
					return 1
				return 0
			})
		const hasAudio = message.parts.some(
			p => p.type === 'audio'
		)
		const hasVisibleContent =
			!!message.thinking || visibleParts.length > 0
		if (!hasVisibleContent) return null

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
						{visibleParts.map((part, i) => (
							<PartRenderer
								key={`${part.type}-${i}`}
								part={part}
								isStreaming={message.isStreaming}
								isTranscription={
									hasAudio && part.type === 'text'
								}
								toolResults={toolResults}
								consumedToolCallIds={consumedToolCallIds}
							/>
						))}
					</div>
					{/* {message.text && !message.isStreaming && (
						<MessageActions className="opacity-0 transition-opacity group-hover:opacity-100">
							<CopyButton text={message.text} />
						</MessageActions>
					)} */}
				</MessageContent>
			</Message>
		)
	}
)
