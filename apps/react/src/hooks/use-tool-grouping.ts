import { useMemo } from 'react'
import type { ContentPart } from '@ellie/schemas/chat'
import type { StoredChatMessage } from '../collections/chat-messages'

export type ToolResultPart = Extract<
	ContentPart,
	{ type: 'tool-result' }
>

export function useToolGrouping(
	messages: StoredChatMessage[],
	streamingMessage: StoredChatMessage | null
) {
	const allMessages = useMemo(
		() =>
			streamingMessage
				? [...messages, streamingMessage]
				: messages,
		[messages, streamingMessage]
	)

	const toolResults = useMemo(() => {
		const map = new Map<string, ToolResultPart>()
		for (const msg of allMessages) {
			for (const part of msg.parts) {
				if (part.type !== 'tool-result' || !part.toolCallId)
					continue
				map.set(part.toolCallId, part)
			}
		}
		return map
	}, [allMessages])

	const consumedToolCallIds = useMemo(() => {
		const set = new Set<string>()
		for (const msg of allMessages) {
			for (const part of msg.parts) {
				if (part.type !== 'tool-call' || !part.toolCallId)
					continue
				if (!toolResults.has(part.toolCallId)) continue
				set.add(part.toolCallId)
			}
		}
		return set
	}, [allMessages, toolResults])

	const hiddenMessageIds = useMemo(() => {
		const set = new Set<string>()
		for (const msg of allMessages) {
			if (
				msg.parts.length !== 1 ||
				msg.parts[0].type !== 'tool-result'
			)
				continue
			const part = msg.parts[0] as ToolResultPart
			if (
				part.toolCallId &&
				consumedToolCallIds.has(part.toolCallId)
			) {
				set.add(msg.id)
			}
		}
		return set
	}, [allMessages, consumedToolCallIds])

	return {
		allMessages,
		toolResults,
		consumedToolCallIds,
		hiddenMessageIds
	}
}
