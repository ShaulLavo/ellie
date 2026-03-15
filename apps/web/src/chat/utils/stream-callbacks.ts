import type { StoredChatMessage } from '@/chat/types'
import type { EventRow } from '@/lib/stream'
import {
	type BranchStats,
	computeStatsFromEvents
} from '@/lib/chat/branch-stats'
import {
	AGENT_START_TYPES,
	AGENT_END_TYPES,
	isAgentRunOpen,
	eventToStored,
	parsePayload
} from '../event-transforms'
import {
	RENDERABLE_TYPES,
	isStreamingAssistantEvent,
	isRenderableMessage,
	toStreamingAssistantMessage,
	getOpenStreamingAssistantEvent,
	finalizeStreamingMessage
} from './stream-event-handlers'
import { snapshotToMessages } from './snapshot-transform'
import type { EventType } from '@ellie/schemas/events'

function extractInputTokens(event: EventRow): number {
	const parsed = parsePayload(event.payload)
	const msg = parsed.message as
		| Record<string, unknown>
		| undefined
	const usage = msg?.usage as { input?: number } | undefined
	return usage?.input ?? 0
}

/** Merge a delta into previous branch stats. */
export function mergeStats(
	prev: BranchStats,
	delta: BranchStats
): BranchStats {
	return {
		model: delta.model ?? prev.model,
		provider: delta.provider ?? prev.provider,
		messageCount: prev.messageCount + delta.messageCount,
		promptTokens: prev.promptTokens + delta.promptTokens,
		completionTokens:
			prev.completionTokens + delta.completionTokens,
		totalCost: prev.totalCost + delta.totalCost,
		lastPromptTokens:
			delta.lastPromptTokens || prev.lastPromptTokens
	}
}

export interface StreamDispatch {
	setStreamingMessage: (
		msg: StoredChatMessage | null
	) => void
	setBranchStats: (
		updater:
			| BranchStats
			| ((prev: BranchStats) => BranchStats)
	) => void
	setIsAgentRunning: (running: boolean) => void
	upsert: (msgs: StoredChatMessage[]) => void
	replaceAll: (msgs: StoredChatMessage[]) => void
	getStreamingMessage: () => StoredChatMessage | null
}

export function handleSnapshot(
	events: EventRow[],
	branchChanged: boolean,
	dispatch: StreamDispatch
) {
	const msgs = snapshotToMessages(events)
	const nextStats = computeStatsFromEvents(events)

	if (branchChanged) {
		dispatch.setStreamingMessage(null)
		dispatch.setIsAgentRunning(false)
	}
	dispatch.replaceAll(msgs)

	const streamingEvent =
		getOpenStreamingAssistantEvent(events)
	if (streamingEvent) {
		dispatch.setStreamingMessage(
			toStreamingAssistantMessage(streamingEvent)
		)
	} else if (!branchChanged) {
		dispatch.setStreamingMessage(null)
	}

	dispatch.setBranchStats(nextStats)
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
			dispatch.upsert([finalized])
		}
		dispatch.setStreamingMessage(null)
	}

	if (event.type === 'assistant_message') {
		if (isStreamingAssistantEvent(event)) {
			dispatch.setStreamingMessage(
				toStreamingAssistantMessage(event)
			)
			const inputTokens = extractInputTokens(event)
			if (inputTokens > 0) {
				dispatch.setBranchStats(prev => ({
					...prev,
					lastPromptTokens: inputTokens
				}))
			}
			return
		}

		dispatch.setStreamingMessage(null)
		const stored = eventToStored(event)
		if (isRenderableMessage(stored)) {
			dispatch.upsert([stored])
		}

		const delta = computeStatsFromEvents([event])
		dispatch.setBranchStats(prev => mergeStats(prev, delta))
		return
	}

	if (event.type === 'tool_execution') {
		const msg = eventToStored(event)
		if (msg.parts.length === 0 && !msg.text) return
		dispatch.upsert([msg])
		return
	}

	if (event.type === 'assistant_artifact') {
		const msg = eventToStored(event)
		if (msg.parts.length === 0) return
		dispatch.upsert([msg])
		return
	}

	if (event.type === 'user_message') {
		const delta = computeStatsFromEvents([event])
		dispatch.setBranchStats(prev => mergeStats(prev, delta))
	}

	if (!RENDERABLE_TYPES.includes(event.type as EventType))
		return

	const msg = eventToStored(event)
	if (msg.parts.length === 0 && !msg.text) return
	dispatch.upsert([msg])
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
			const inputTokens = extractInputTokens(event)
			if (inputTokens > 0) {
				dispatch.setBranchStats(prev => ({
					...prev,
					lastPromptTokens: inputTokens
				}))
			}
			return
		}

		const stored = eventToStored(event)
		dispatch.setStreamingMessage(null)
		if (isRenderableMessage(stored)) {
			dispatch.upsert([stored])
		}

		const delta = computeStatsFromEvents([event])
		dispatch.setBranchStats(prev => mergeStats(prev, delta))
		return
	}

	if (event.type === 'tool_execution') {
		const msg = eventToStored(event)
		if (!isRenderableMessage(msg)) return
		dispatch.upsert([msg])
	}
}
