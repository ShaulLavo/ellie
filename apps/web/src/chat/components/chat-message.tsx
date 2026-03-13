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

		// Collect visible nested parts
		const visibleToolParts = (toolItems ?? []).flatMap(
			msg =>
				msg.parts.filter(part =>
					partHasVisibleOutput(part, consumedToolCallIds)
				)
		)
		// Audio artifacts before media artifacts
		const sortedArtifactParts = (artifactItems ?? [])
			.flatMap(msg => msg.parts)
			.sort((a, b) => {
				const aIsAudio =
					a.type === 'assistant-artifact' &&
					a.kind === 'audio'
				const bIsAudio =
					b.type === 'assistant-artifact' &&
					b.kind === 'audio'
				if (aIsAudio && !bIsAudio) return -1
				if (!aIsAudio && bIsAudio) return 1
				return 0
			})

		const hasVisibleContent =
			!!message.thinking ||
			visibleParts.length > 0 ||
			visibleToolParts.length > 0 ||
			sortedArtifactParts.length > 0
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
						{/* Audio artifacts (TTS) render before text */}
						{sortedArtifactParts
							.filter(
								p =>
									p.type === 'assistant-artifact' &&
									p.kind === 'audio'
							)
							.map((part, i) => (
								<PartRenderer
									key={`artifact-audio-${i}`}
									part={part}
								/>
							))}
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
						{/* Nested tool items */}
						{visibleToolParts.map((part, i) => (
							<PartRenderer
								key={`tool-${i}`}
								part={part}
								toolResults={toolResults}
								consumedToolCallIds={consumedToolCallIds}
							/>
						))}
						{/* Non-audio artifacts (media, files) render after text */}
						{sortedArtifactParts
							.filter(
								p =>
									p.type !== 'assistant-artifact' ||
									p.kind !== 'audio'
							)
							.map((part, i) => (
								<PartRenderer
									key={`artifact-media-${i}`}
									part={part}
								/>
							))}
					</div>
				</MessageContent>
			</Message>
		)
	}
)
