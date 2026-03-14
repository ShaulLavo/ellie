import type { EventType } from '@ellie/schemas/events'
import type { StoredChatMessage } from '@/chat/types'
import type { EventRow } from '@/lib/stream'
import { eventToStored } from '../event-transforms'

/** Event types that produce renderable chat messages. */
export const RENDERABLE_TYPES: EventType[] = [
	'user_message',
	'assistant_message',
	'assistant_artifact',
	'tool_execution',
	'memory_recall',
	'memory_retain',
	'session_rotated',
	'error'
]

export function isStreamingAssistantEvent(event: {
	type: string
	payload: unknown
}): boolean {
	if (event.type !== 'assistant_message') return false
	try {
		const parsed =
			typeof event.payload === 'string'
				? JSON.parse(event.payload)
				: event.payload
		return (
			(parsed as Record<string, unknown>).streaming === true
		)
	} catch {
		return false
	}
}

export function isRenderableMessage(
	message: StoredChatMessage
): boolean {
	return (
		message.parts.length > 0 ||
		Boolean(message.text) ||
		Boolean(message.thinking)
	)
}

export function toStreamingAssistantMessage(
	event: EventRow
): StoredChatMessage | null {
	const stored = eventToStored(event)
	if (!isRenderableMessage(stored)) return null
	return {
		...stored,
		isStreaming: true
	}
}

export function getOpenStreamingAssistantEvent(
	events: EventRow[]
): EventRow | undefined {
	const closedRunIds = getClosedRunIds(events)

	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]
		if (!event || !isStreamingAssistantEvent(event))
			continue
		if (event.runId && closedRunIds.has(event.runId))
			continue
		return event
	}

	return undefined
}

export function getClosedRunIds(
	events: EventRow[]
): Set<string> {
	return new Set(
		events
			.filter(
				event =>
					event.type === 'run_closed' && event.runId != null
			)
			.map(event => event.runId as string)
	)
}

export function isClosedRunEvent(
	event: EventRow,
	closedRunIds: Set<string>
): boolean {
	if (!event.runId) return false
	return closedRunIds.has(event.runId)
}

export function shouldRenderInSnapshot(
	event: EventRow,
	lastRotatedIdx: number,
	closedRunIds: Set<string>
): boolean {
	if (!RENDERABLE_TYPES.includes(event.type as EventType)) {
		return false
	}
	if (
		event.type === 'session_rotated' &&
		event.seq !== lastRotatedIdx
	) {
		return false
	}
	if (!isStreamingAssistantEvent(event)) return true
	return isClosedRunEvent(event, closedRunIds)
}

export function finalizeStreamingMessage(
	message: StoredChatMessage | null
): StoredChatMessage | null {
	if (!message) return null
	return {
		...message,
		isStreaming: false
	}
}
