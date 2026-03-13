import type { StoredChatMessage } from '@/collections/chat-messages'
import type { ToolResultPart } from '../utils'

// ── Public types ──────────────────────────────────────────────

export type { ToolResultPart }

interface UserTimelineItem {
	type: 'user'
	message: StoredChatMessage
}

interface AssistantReplyItem {
	type: 'assistant-reply'
	message: StoredChatMessage
	toolItems: StoredChatMessage[]
	artifactItems: StoredChatMessage[]
}

interface SystemTimelineItem {
	type: 'system'
	message: StoredChatMessage
}

export type TimelineItem =
	| UserTimelineItem
	| AssistantReplyItem
	| SystemTimelineItem

// ── Projection logic ──────────────────────────────────────────

function projectTimeline(
	allMessages: StoredChatMessage[]
): {
	timeline: TimelineItem[]
	toolResults: Map<string, ToolResultPart>
	consumedToolCallIds: Set<string>
} {
	// Build parent -> children index
	const childrenByParent = new Map<
		string,
		StoredChatMessage[]
	>()
	const consumedIds = new Set<string>()

	for (const msg of allMessages) {
		if (msg.parentMessageId) {
			let list = childrenByParent.get(msg.parentMessageId)
			if (!list) {
				list = []
				childrenByParent.set(msg.parentMessageId, list)
			}
			list.push(msg)
		}
	}

	// Collect tool results
	const toolResults = new Map<string, ToolResultPart>()
	for (const msg of allMessages) {
		if (msg.eventType === 'tool_execution') {
			for (const part of msg.parts) {
				if (
					part.type === 'tool-result' &&
					part.toolCallId
				) {
					toolResults.set(
						part.toolCallId,
						part as ToolResultPart
					)
					consumedIds.add(part.toolCallId)
				}
			}
		}
	}

	// Build timeline
	const timeline: TimelineItem[] = []

	for (const msg of allMessages) {
		const et = msg.eventType

		// Skip children that are consumed by their parent
		if (
			(et === 'tool_execution' ||
				et === 'assistant_artifact') &&
			msg.parentMessageId
		) {
			continue
		}

		if (et === 'user_message') {
			timeline.push({ type: 'user', message: msg })
		} else if (et === 'assistant_message') {
			const children = childrenByParent.get(msg.id) ?? []
			timeline.push({
				type: 'assistant-reply',
				message: msg,
				toolItems: children.filter(
					c => c.eventType === 'tool_execution'
				),
				artifactItems: children.filter(
					c => c.eventType === 'assistant_artifact'
				)
			})
		} else {
			// memory_recall, memory_retain, session_rotated, error,
			// or messages without eventType
			timeline.push({ type: 'system', message: msg })
		}
	}

	return {
		timeline,
		toolResults,
		consumedToolCallIds: consumedIds
	}
}

// ── Hook ──────────────────────────────────────────────────────

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
