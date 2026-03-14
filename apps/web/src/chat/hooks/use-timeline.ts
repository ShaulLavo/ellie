import { useMemo } from 'react'
import type { StoredChatMessage } from '@/chat/types'
import type { ToolResultPart } from '../utils'
import {
	projectTimeline,
	type TimelineItem
} from '../utils/project-timeline'

export type { ToolResultPart, TimelineItem }

// ── Hook ──────────────────────────────────────────────────────

export function useTimeline(
	messages: StoredChatMessage[],
	streamingMessage?: StoredChatMessage | null
) {
	const allMessages = streamingMessage
		? [...messages, streamingMessage]
		: messages

	const { timeline, toolResults, consumedToolCallIds } =
		useMemo(
			() => projectTimeline(allMessages),
			[messages, streamingMessage]
		)

	return {
		timeline,
		allMessages,
		toolResults,
		consumedToolCallIds
	}
}
