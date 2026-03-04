import type {
	ContentPart,
	MessageSender
} from '@ellie/schemas/chat'
import type { StoredChatMessage } from '@/collections/chat-messages'
import type { EventRow } from '@/lib/stream'

/** Agent lifecycle event types */
export const AGENT_START_TYPES = new Set(['agent_start'])
export const AGENT_END_TYPES = new Set([
	'agent_end',
	'run_closed'
])

export function isAgentRunOpen(rows: EventRow[]): boolean {
	let open = false
	for (const row of rows) {
		if (AGENT_START_TYPES.has(row.type)) open = true
		if (AGENT_END_TYPES.has(row.type)) open = false
	}
	return open
}

/** Extract content parts from a tool_call event payload. */
function extractToolCallParts(
	parsed: Record<string, unknown>
): ContentPart[] {
	return [
		{
			type: 'tool-call',
			name: parsed.name as string,
			args:
				(parsed.arguments as Record<string, unknown>) ?? {},
			toolCallId: parsed.id as string
		}
	]
}

/** Extract content parts from a tool_result event payload. */
function extractToolResultParts(
	parsed: Record<string, unknown>
): ContentPart[] {
	const resultContent = Array.isArray(parsed.content)
		? (
				parsed.content as Array<{
					type: string
					text?: string
				}>
			)
				.filter(c => c.type === 'text')
				.map(c => c.text ?? '')
				.join('')
		: ''
	return [
		{
			type: 'tool-result',
			toolName: parsed.toolName as string,
			toolCallId: parsed.toolCallId as string,
			result: resultContent
		}
	]
}

/** Extract content parts from memory_recall / memory_retain event payloads. */
function extractMemoryParts(
	parsed: Record<string, unknown>
): ContentPart[] {
	return (parsed.parts as ContentPart[]) ?? []
}

/** Extract content parts from an error event payload. */
function extractErrorParts(
	parsed: Record<string, unknown>
): ContentPart[] {
	const errorText =
		typeof parsed.message === 'string'
			? parsed.message
			: 'An unexpected error occurred'
	return [{ type: 'text', text: errorText }]
}

/** Extract content parts from standard message event payloads (user_message, assistant_final, etc.). */
function extractMessageParts(
	parsed: Record<string, unknown>
): ContentPart[] {
	if (Array.isArray(parsed.content)) {
		return parsed.content as ContentPart[]
	}
	if (Array.isArray(parsed.parts)) {
		return parsed.parts as ContentPart[]
	}
	if (
		typeof parsed.content === 'string' &&
		parsed.content
	) {
		return [{ type: 'text', text: parsed.content }]
	}

	// Surface API errors: when assistant_final has stopReason 'error'
	// but empty content, synthesize a text part from errorMessage
	if (
		parsed.stopReason === 'error' &&
		typeof parsed.errorMessage === 'string'
	) {
		return [
			{
				type: 'text',
				text: `Error: ${parsed.errorMessage}`
			}
		]
	}

	return []
}

/** Convert an EventRow into a StoredChatMessage (no Date allocation). */
export function eventToStored(
	row: EventRow
): StoredChatMessage {
	const parsed =
		typeof row.payload === 'string'
			? (JSON.parse(row.payload) as Record<string, unknown>)
			: (row.payload as Record<string, unknown>)

	// Dispatch to the right helper based on event type
	let parts: ContentPart[]
	if (row.type === 'assistant_message') {
		// Unified type: message is wrapped in { message, streaming }
		const msg = parsed.message as Record<string, unknown>
		parts = extractMessageParts(msg)
	} else if (row.type === 'tool_execution') {
		const status = parsed.status as string
		if (status === 'complete' || status === 'error') {
			// Show result for completed tools
			parts = extractToolResultParts({
				toolName: parsed.toolName,
				toolCallId: parsed.toolCallId,
				content: (parsed.result as Record<string, unknown>)
					?.content
			})
		} else {
			// Show loading state for running tools
			parts = extractToolCallParts({
				name: parsed.toolName,
				arguments: parsed.args,
				id: parsed.toolCallId
			})
		}
	} else if (row.type === 'tool_call') {
		parts = extractToolCallParts(parsed)
	} else if (row.type === 'tool_result') {
		parts = extractToolResultParts(parsed)
	} else if (
		row.type === 'memory_recall' ||
		row.type === 'memory_retain'
	) {
		parts = extractMemoryParts(parsed)
	} else if (row.type === 'error') {
		parts = extractErrorParts(parsed)
	} else {
		parts = extractMessageParts(parsed)
	}

	const text = parts
		.filter(
			(p): p is Extract<ContentPart, { type: 'text' }> =>
				p.type === 'text'
		)
		.map(p => p.text)
		.join('\n')

	const thinking =
		parts
			.filter(
				(
					p
				): p is Extract<
					ContentPart,
					{ type: 'thinking' }
				> => p.type === 'thinking'
			)
			.map(p => p.text)
			.join('\n') || undefined

	// Filter out non-renderable blocks:
	// - thinking: extracted above for separate display
	// - toolCall: agent-internal camelCase format, already rendered via tool_result events
	const filteredParts = parts.filter(
		p =>
			p.type !== 'thinking' &&
			(p as Record<string, unknown>).type !== 'toolCall'
	)

	// Determine sender from event type or payload
	let sender: MessageSender | undefined
	if (
		row.type === 'user_message' ||
		parsed.role === 'user'
	) {
		sender = 'user'
	} else if (
		row.type === 'assistant_message' ||
		row.type === 'assistant_final' ||
		parsed.role === 'assistant'
	) {
		sender = 'agent'
	} else if (parsed.role === 'system') {
		sender = 'system'
	} else if (row.type === 'error') {
		sender = 'agent'
	} else if (row.type.startsWith('tool_')) {
		sender = 'agent'
	} else if (row.type.startsWith('memory_')) {
		sender = 'memory'
	}

	return {
		id: String(row.id),
		timestamp: new Date(row.createdAt).toISOString(),
		text,
		parts: filteredParts,
		seq: row.seq,
		sender,
		thinking
	}
}
