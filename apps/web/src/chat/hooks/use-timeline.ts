import { useMemo } from 'react'
import type { StoredChatMessage } from '@/chat/types'
import type { ToolResultPart } from '../utils'

// ── Public types ──────────────────────────────────────────────

export type { ToolResultPart }

interface UserTimelineItem {
	type: 'user'
	message: StoredChatMessage
}

interface AssistantTurnItem {
	type: 'assistant-turn'
	runId: string
	/** The last assistant_message in the run — the visible answer. */
	finalMessage: StoredChatMessage
	/** All other messages in the run, in seq order (memory, tools, artifacts, interim text). */
	steps: StoredChatMessage[]
}

interface SystemTimelineItem {
	type: 'system'
	message: StoredChatMessage
}

export type TimelineItem =
	| UserTimelineItem
	| AssistantTurnItem
	| SystemTimelineItem

// ── Projection logic ──────────────────────────────────────────

function projectTimeline(
	allMessages: StoredChatMessage[]
): {
	timeline: TimelineItem[]
	toolResults: Map<string, ToolResultPart>
	consumedToolCallIds: Set<string>
} {
	// Collect tool results for inline display
	const toolResults = new Map<string, ToolResultPart>()
	const consumedIds = new Set<string>()

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
				// image-generation parts also consume their tool-call placeholder
				if (
					part.type === 'image-generation' &&
					part.toolCallId
				) {
					consumedIds.add(part.toolCallId)
				}
			}
		}
	}

	// Group messages by runId (excluding user messages — they stay top-level)
	const runMessages = new Map<string, StoredChatMessage[]>()
	for (const msg of allMessages) {
		if (msg.runId && msg.eventType !== 'user_message') {
			let list = runMessages.get(msg.runId)
			if (!list) {
				list = []
				runMessages.set(msg.runId, list)
			}
			list.push(msg)
		}
	}

	// Build timeline
	const timeline: TimelineItem[] = []
	const processedRunIds = new Set<string>()

	for (const msg of allMessages) {
		const et = msg.eventType

		// User messages are always standalone top-level items
		if (et === 'user_message') {
			timeline.push({ type: 'user', message: msg })
			continue
		}

		// Messages with a runId are grouped into a single assistant turn
		if (msg.runId) {
			if (processedRunIds.has(msg.runId)) continue
			processedRunIds.add(msg.runId)

			const runMsgs = runMessages.get(msg.runId)!

			// Find the last assistant_message as the final answer
			let finalMessage: StoredChatMessage | undefined
			for (let i = runMsgs.length - 1; i >= 0; i--) {
				if (runMsgs[i].eventType === 'assistant_message') {
					finalMessage = runMsgs[i]
					break
				}
			}

			// Steps = everything except the final message, in seq order
			const steps = finalMessage
				? runMsgs.filter(m => m !== finalMessage)
				: runMsgs.slice(0, -1)

			// If no assistant_message yet (mid-run), use last message as placeholder
			const display =
				finalMessage ?? runMsgs[runMsgs.length - 1]

			timeline.push({
				type: 'assistant-turn',
				runId: msg.runId,
				finalMessage: display,
				steps: finalMessage ? steps : steps
			})
			continue
		}

		// Messages without a runId that aren't user messages → system
		timeline.push({ type: 'system', message: msg })
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
	const allMessages = useMemo(
		() =>
			streamingMessage
				? [...messages, streamingMessage]
				: messages,
		[messages, streamingMessage]
	)

	const { timeline, toolResults, consumedToolCallIds } =
		useMemo(
			() => projectTimeline(allMessages),
			[allMessages]
		)

	return {
		timeline,
		allMessages,
		toolResults,
		consumedToolCallIds
	}
}
