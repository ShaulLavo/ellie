import type { AgentMessage } from '@ellie/schemas'
export { reorderToolResults } from '@ellie/schemas/agent'
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
