import type { AgentMessage } from '@ellie/schemas'
import type { EventRow } from './schema'

/**
 * Parse an event row into an AgentMessage, or return null to skip it.
 */
export function parseEventRow(
	row: EventRow
): AgentMessage | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(row.payload)
	} catch {
		return null // Skip rows with malformed JSON
	}

	if (row.type === 'assistant_message') {
		const wrapper = parsed as {
			message: AgentMessage
			streaming: boolean
		}
		if (wrapper.streaming) return null // Skip in-flight messages
		return wrapper.message
	}

	if (row.type === 'tool_execution') {
		const data = parsed as {
			toolCallId: string
			toolName: string
			args: unknown
			result?: {
				content: Array<{
					type: string
					text?: string
					data?: string
					mimeType?: string
				}>
				details: unknown
			}
			isError?: boolean
			status: string
		}
		if (data.status === 'running') return null // Skip in-flight tools
		return {
			role: 'toolResult',
			toolCallId: data.toolCallId,
			toolName: data.toolName,
			content: data.result?.content ?? [],
			details: data.result?.details,
			isError: data.isError ?? false,
			timestamp: row.createdAt
		} as AgentMessage
	}

	const msg = parsed as AgentMessage
	// Skip empty assistant messages — these are artifacts
	// from multi-turn finalization that break tool_use ↔
	// tool_result pairing required by the Anthropic API.
	if (
		msg.role === 'assistant' &&
		Array.isArray(msg.content) &&
		msg.content.length === 0
	) {
		return null
	}
	return msg
}

/**
 * Reorder messages so each toolResult comes after its parent assistant message.
 *
 * During a multi-turn run, tool_execution events are persisted before the
 * assistant message finalizes because tools execute during the stream.
 * Loading by seq gives [toolResult, assistant] — but the API expects
 * [assistant, toolResult].
 */
export function reorderToolResults(
	messages: AgentMessage[]
): AgentMessage[] {
	const result: AgentMessage[] = []
	const deferred: AgentMessage[] = []
	const seenToolCallIds = new Set<string>()

	for (const msg of messages) {
		if (msg.role === 'assistant') {
			result.push(msg)
			for (const id of extractToolCallIds(msg)) {
				seenToolCallIds.add(id)
			}
			flushDeferred(deferred, seenToolCallIds, result)
		} else if (msg.role === 'toolResult') {
			const toolCallId = (msg as { toolCallId: string })
				.toolCallId
			if (seenToolCallIds.has(toolCallId)) {
				result.push(msg)
			} else {
				deferred.push(msg)
			}
		} else {
			result.push(msg)
		}
	}

	// Append any remaining deferred (orphans — shouldn't happen normally)
	result.push(...deferred)

	return result
}

function extractToolCallIds(msg: AgentMessage): string[] {
	const ids: string[] = []
	for (const block of msg.content) {
		if (block.type === 'toolCall') {
			ids.push(
				(block as { type: 'toolCall'; id: string }).id
			)
		}
	}
	return ids
}

function flushDeferred(
	deferred: AgentMessage[],
	seenToolCallIds: Set<string>,
	result: AgentMessage[]
): void {
	const stillDeferred: AgentMessage[] = []
	for (const d of deferred) {
		const isReady =
			d.role === 'toolResult' &&
			seenToolCallIds.has(
				(d as { toolCallId: string }).toolCallId
			)
		if (isReady) {
			result.push(d)
		} else {
			stillDeferred.push(d)
		}
	}
	deferred.length = 0
	deferred.push(...stillDeferred)
}
