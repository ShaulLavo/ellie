import type { StoredChatMessage } from '@/collections/chat-messages'
import type { EventRow } from '@/lib/stream'
import {
	type SessionStats,
	EMPTY_STATS,
	computeStatsFromEvents
} from '@/lib/chat/session-stats'
import {
	AGENT_START_TYPES,
	AGENT_END_TYPES,
	isAgentRunOpen,
	eventToStored
} from '../event-transforms'
import {
	RENDERABLE_TYPES,
	isStreamingAssistantEvent,
	isRenderableMessage,
	toStreamingAssistantMessage,
	getOpenStreamingAssistantEvent,
	getClosedRunIds,
	shouldRenderInSnapshot,
	finalizeStreamingMessage
} from './stream-event-handlers'
import type { EventType } from '@ellie/schemas/events'

/** Merge a delta into previous session stats. */
export function mergeStats(
	prev: SessionStats,
	delta: SessionStats
): SessionStats {
	return {
		model: delta.model ?? prev.model,
		provider: delta.provider ?? prev.provider,
		messageCount: prev.messageCount + delta.messageCount,
		promptTokens: prev.promptTokens + delta.promptTokens,
		completionTokens:
			prev.completionTokens + delta.completionTokens,
		totalCost: prev.totalCost + delta.totalCost
	}
}

export interface StreamDispatch {
	setStreamingMessage: (
		msg: StoredChatMessage | null
	) => void
	setSessionStats: (
		updater:
			| SessionStats
			| ((prev: SessionStats) => SessionStats)
	) => void
	setIsAgentRunning: (running: boolean) => void
	syncWrite: (msgs: StoredChatMessage[]) => void
	syncReplaceAll: (msgs: StoredChatMessage[]) => void
	getStreamingMessage: () => StoredChatMessage | null
}

export function handleSnapshot(
	events: EventRow[],
	sessionChanged: boolean,
	dispatch: StreamDispatch
) {
	let lastRotatedIdx = -1
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === 'session_rotated') {
			lastRotatedIdx = events[i].seq
			break
		}
	}
	const closedRunIds = getClosedRunIds(events)

	const msgs = events
		.filter(event =>
			shouldRenderInSnapshot(
				event,
				lastRotatedIdx,
				closedRunIds
			)
		)
		.map(event => {
			const message = eventToStored(event)
			if (!isStreamingAssistantEvent(event)) {
				return message
			}
			return finalizeStreamingMessage(message)
		})
		.filter(
			(message): message is StoredChatMessage =>
				message != null && isRenderableMessage(message)
		)

	if (sessionChanged) {
		dispatch.setStreamingMessage(null)
		dispatch.setSessionStats(EMPTY_STATS)
		dispatch.setIsAgentRunning(false)
	}
	dispatch.syncReplaceAll(msgs)

	const streamingEvent =
		getOpenStreamingAssistantEvent(events)
	if (streamingEvent) {
		dispatch.setStreamingMessage(
			toStreamingAssistantMessage(streamingEvent)
		)
	} else if (!sessionChanged) {
		dispatch.setStreamingMessage(null)
	}

	dispatch.setSessionStats(computeStatsFromEvents(events))
	dispatch.setIsAgentRunning(isAgentRunOpen(events))
}

export function handleAppend(
	event: EventRow,
	dispatch: StreamDispatch
) {
	if (AGENT_START_TYPES.has(event.type)) {
		dispatch.setIsAgentRunning(true)
	} else if (AGENT_END_TYPES.has(event.type)) {
		dispatch.setIsAgentRunning(false)
		const finalized = finalizeStreamingMessage(
			dispatch.getStreamingMessage()
		)
		if (finalized && isRenderableMessage(finalized)) {
			dispatch.syncWrite([finalized])
		}
		dispatch.setStreamingMessage(null)
	}

	if (event.type === 'assistant_message') {
		if (isStreamingAssistantEvent(event)) {
			dispatch.setStreamingMessage(
				toStreamingAssistantMessage(event)
			)
			return
		}

		dispatch.setStreamingMessage(null)
		const stored = eventToStored(event)
		if (isRenderableMessage(stored)) {
			dispatch.syncWrite([stored])
		}

		const delta = computeStatsFromEvents([event])
		dispatch.setSessionStats(prev =>
			mergeStats(prev, delta)
		)
		return
	}

	if (event.type === 'tool_execution') {
		const msg = eventToStored(event)
		if (msg.parts.length === 0 && !msg.text) return
		dispatch.syncWrite([msg])
		return
	}

	if (event.type === 'assistant_artifact') {
		const msg = eventToStored(event)
		if (msg.parts.length === 0) return
		dispatch.syncWrite([msg])
		return
	}

	if (event.type === 'user_message') {
		const delta = computeStatsFromEvents([event])
		dispatch.setSessionStats(prev =>
			mergeStats(prev, delta)
		)
	}

	if (!RENDERABLE_TYPES.includes(event.type as EventType))
		return

	const msg = eventToStored(event)
	if (msg.parts.length === 0 && !msg.text) return
	dispatch.syncWrite([msg])
}

export function handleUpdate(
	event: EventRow,
	dispatch: StreamDispatch
) {
	if (event.type === 'assistant_message') {
		if (isStreamingAssistantEvent(event)) {
			dispatch.setStreamingMessage(
				toStreamingAssistantMessage(event)
			)
			return
		}

		const stored = eventToStored(event)
		dispatch.setStreamingMessage(null)
		if (isRenderableMessage(stored)) {
			dispatch.syncWrite([stored])
		}

		const delta = computeStatsFromEvents([event])
		dispatch.setSessionStats(prev =>
			mergeStats(prev, delta)
		)
		return
	}

	if (event.type === 'tool_execution') {
		const msg = eventToStored(event)
		if (!isRenderableMessage(msg)) return
		dispatch.syncWrite([msg])
	}
}
