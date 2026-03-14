import type { StoredChatMessage } from '@/chat/types'
import {
	Message,
	MessageContent
} from '@/components/ai-elements/message'
import type { ToolResultPart } from '../utils'
import { getVisibleParts } from '../utils/message-utils'
import { MessageHeader } from './message-header'
import { MessageThinking } from './message-thinking'
import { MessagePartsList } from './message-parts-list'
import { TurnStep } from './turn-step'

export function AssistantTurnRow({
	finalMessage,
	steps,
	toolResults,
	consumedToolCallIds
}: {
	finalMessage: StoredChatMessage
	steps: StoredChatMessage[]
	toolResults?: Map<string, ToolResultPart>
	consumedToolCallIds?: Set<string>
}) {
	const isFinalAnAssistantMessage =
		finalMessage.eventType === 'assistant_message'

	const finalVisibleParts = isFinalAnAssistantMessage
		? getVisibleParts(
				finalMessage.parts,
				consumedToolCallIds
			)
		: []

	const hasAudio = isFinalAnAssistantMessage
		? finalMessage.parts.some(p => p.type === 'audio')
		: false

	const hasFinalContent =
		finalVisibleParts.length > 0 || !!finalMessage.thinking

	// Split steps: tools/artifacts that belong to the final message render after its thinking/text,
	// everything else (memory, interim text, earlier tools) renders before.
	const preAnswerSteps: StoredChatMessage[] = []
	const finalMessageTools: StoredChatMessage[] = []

	if (isFinalAnAssistantMessage) {
		for (const step of steps) {
			const belongsToFinal =
				step.parentMessageId === finalMessage.id ||
				(!step.parentMessageId &&
					step.seq > finalMessage.seq &&
					(step.eventType === 'tool_execution' ||
						step.eventType === 'assistant_artifact'))
			if (belongsToFinal) {
				finalMessageTools.push(step)
			} else {
				preAnswerSteps.push(step)
			}
		}
	}

	// If the final message is not an assistant_message (mid-run, only steps so far),
	// render it as a step instead
	const allSteps =
		!isFinalAnAssistantMessage && steps.length === 0
			? [finalMessage]
			: !isFinalAnAssistantMessage
				? steps
				: preAnswerSteps

	if (
		allSteps.length === 0 &&
		finalMessageTools.length === 0 &&
		!hasFinalContent
	)
		return null

	return (
		<Message
			from="assistant"
			className="animate-message-in"
		>
			<MessageHeader
				sender="agent"
				timestamp={finalMessage.timestamp}
			/>
			<MessageContent>
				<div className="flex flex-col gap-2">
					{/* Pre-answer steps: memory, interim text, earlier tools — chronological */}
					{allSteps.map(step => (
						<TurnStep
							key={step.id}
							message={step}
							toolResults={toolResults}
							consumedToolCallIds={consumedToolCallIds}
						/>
					))}

					{/* Final answer: thinking, text, then its own tools/artifacts */}
					{isFinalAnAssistantMessage && (
						<>
							{finalMessage.thinking && (
								<MessageThinking
									thinking={finalMessage.thinking}
									isStreaming={finalMessage.isStreaming}
								/>
							)}
							<MessagePartsList
								visibleParts={finalVisibleParts}
								isStreaming={finalMessage.isStreaming}
								hasAudio={hasAudio}
								toolResults={toolResults}
								consumedToolCallIds={consumedToolCallIds}
							/>
							{finalMessageTools.map(step => (
								<TurnStep
									key={step.id}
									message={step}
									toolResults={toolResults}
									consumedToolCallIds={consumedToolCallIds}
								/>
							))}
						</>
					)}
				</div>
			</MessageContent>
		</Message>
	)
}
