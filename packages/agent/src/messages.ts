/**
 * Message conversion bridge between @ellie/agent types and TanStack AI types.
 */

import type { ModelMessage, ContentPart } from '@tanstack/ai'
import type {
	Message,
	UserMessage,
	AssistantMessage,
	ToolResultMessage,
	TextContent,
	ToolCall
} from './types'

/**
 * Convert a single Message to a TanStack AI ModelMessage.
 */
export function toModelMessage(msg: Message): ModelMessage {
	switch (msg.role) {
		case 'user':
			return userToModelMessage(msg)
		case 'assistant':
			return assistantToModelMessage(msg)
		case 'toolResult':
			return toolResultToModelMessage(msg)
	}
}

/**
 * Convert an array of Messages to TanStack AI ModelMessages.
 */
export function toModelMessages(msgs: Message[]): ModelMessage[] {
	return msgs.map(toModelMessage)
}

// ============================================================================
// Internal converters
// ============================================================================

function userToModelMessage(msg: UserMessage): ModelMessage {
	const content = msg.content.map((c): ContentPart => {
		if (c.type === 'text') {
			return { type: 'text', content: c.text }
		}
		// ImageContent
		return {
			type: 'image',
			source: { type: 'data', value: c.data, mimeType: c.mimeType }
		}
	})

	return { role: 'user', content }
}

function assistantToModelMessage(msg: AssistantMessage): ModelMessage {
	const textParts = msg.content.filter((c): c is TextContent => c.type === 'text')
	const toolCalls = msg.content.filter((c): c is ToolCall => c.type === 'toolCall')
	// Thinking content is stripped — providers handle it via modelOptions

	const textContent = textParts.map((c) => c.text).join('')

	const tanStackToolCalls =
		toolCalls.length > 0
			? toolCalls.map((tc) => ({
					id: tc.id,
					type: 'function' as const,
					function: {
						name: tc.name,
						arguments: JSON.stringify(tc.arguments)
					}
				}))
			: undefined

	return {
		role: 'assistant',
		content: textContent || null,
		toolCalls: tanStackToolCalls
	}
}

function toolResultToModelMessage(msg: ToolResultMessage): ModelMessage {
	const textContent = msg.content
		.filter((c): c is TextContent => c.type === 'text')
		.map((c) => c.text)
		.join('')

	return {
		role: 'tool',
		content: textContent,
		toolCallId: msg.toolCallId
	}
}
