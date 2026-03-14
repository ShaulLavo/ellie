import type { StoredChatMessage } from '@/chat/types'
import type { ToolResultPart } from '../utils'

interface UserTimelineItem {
	type: 'user'
	message: StoredChatMessage
}

interface AssistantTurnItem {
	type: 'assistant-turn'
	runId: string
	finalMessage: StoredChatMessage
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

export interface TimelineProjection {
	timeline: TimelineItem[]
	toolResults: Map<string, ToolResultPart>
	consumedToolCallIds: Set<string>
}

export function projectTimeline(
	allMessages: StoredChatMessage[]
): TimelineProjection {
	const toolResults = collectToolResults(allMessages)
	const consumedToolCallIds =
		collectConsumedToolCallIds(allMessages)
	const runMessages = groupRunMessages(allMessages)
	const timeline = buildTimeline(allMessages, runMessages)

	return {
		timeline,
		toolResults,
		consumedToolCallIds
	}
}

function collectToolResults(
	allMessages: StoredChatMessage[]
): Map<string, ToolResultPart> {
	const toolResults = new Map<string, ToolResultPart>()

	for (const message of allMessages) {
		if (message.eventType !== 'tool_execution') continue
		for (const part of message.parts) {
			if (part.type === 'tool-result' && part.toolCallId) {
				toolResults.set(
					part.toolCallId,
					part as ToolResultPart
				)
			}
		}
	}

	return toolResults
}

function collectConsumedToolCallIds(
	allMessages: StoredChatMessage[]
): Set<string> {
	const consumedIds = new Set<string>()

	for (const message of allMessages) {
		if (message.eventType !== 'tool_execution') continue
		for (const part of message.parts) {
			if (
				(part.type === 'tool-result' ||
					part.type === 'image-generation') &&
				part.toolCallId
			) {
				consumedIds.add(part.toolCallId)
			}
		}
	}

	return consumedIds
}

function groupRunMessages(
	allMessages: StoredChatMessage[]
): Map<string, StoredChatMessage[]> {
	const runMessages = new Map<string, StoredChatMessage[]>()

	for (const message of allMessages) {
		if (!shouldGroupIntoAssistantTurn(message)) continue
		let group = runMessages.get(message.runId!)
		if (!group) {
			group = []
			runMessages.set(message.runId!, group)
		}
		group.push(message)
	}

	return runMessages
}

function shouldGroupIntoAssistantTurn(
	message: StoredChatMessage
): boolean {
	if (!message.runId) return false
	if (message.eventType === 'user_message') return false
	return true
}

function buildTimeline(
	allMessages: StoredChatMessage[],
	runMessages: Map<string, StoredChatMessage[]>
): TimelineItem[] {
	const timeline: TimelineItem[] = []
	const processedRunIds = new Set<string>()

	for (const message of allMessages) {
		if (message.eventType === 'user_message') {
			timeline.push({ type: 'user', message })
			continue
		}

		if (!shouldGroupIntoAssistantTurn(message)) {
			timeline.push({ type: 'system', message })
			continue
		}

		if (processedRunIds.has(message.runId!)) continue
		processedRunIds.add(message.runId!)
		timeline.push(
			createAssistantTurnItem(
				message.runId!,
				runMessages.get(message.runId!) ?? []
			)
		)
	}

	return timeline
}

function createAssistantTurnItem(
	runId: string,
	runMessages: StoredChatMessage[]
): AssistantTurnItem {
	const finalMessage =
		findFinalAssistantMessage(runMessages)
	const displayMessage =
		finalMessage ?? runMessages[runMessages.length - 1]
	const steps = finalMessage
		? runMessages.filter(
				message => message !== finalMessage
			)
		: runMessages.slice(0, -1)

	return {
		type: 'assistant-turn',
		runId,
		finalMessage: displayMessage,
		steps
	}
}

function findFinalAssistantMessage(
	runMessages: StoredChatMessage[]
): StoredChatMessage | undefined {
	for (
		let index = runMessages.length - 1;
		index >= 0;
		index--
	) {
		const message = runMessages[index]
		if (message.eventType === 'assistant_message') {
			return message
		}
	}

	return undefined
}
