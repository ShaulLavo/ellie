import type { StoredChatMessage } from '@/chat/types'
import type { ToolResultPart } from '../utils'
import {
	projectTimeline,
	type TimelineItem
} from '../utils/project-timeline'

export type { ToolResultPart, TimelineItem }

export function useTimeline(
	messages: StoredChatMessage[],
	streamingMessage?: StoredChatMessage | null
) {
	const allMessages = streamingMessage
		? [...messages, streamingMessage]
		: messages

	const { timeline, toolResults, consumedToolCallIds } =
		projectTimeline(allMessages)

	return {
		timeline,
		allMessages,
		toolResults,
		consumedToolCallIds
	}
}
