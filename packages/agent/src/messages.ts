/**
 * Message conversion bridge between @ellie/agent types and TanStack AI types.
 */

import type {
	ModelMessage,
	ContentPart
} from '@tanstack/ai'
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
		default: {
			const _exhaustive: never = msg
			throw new Error(
				`Unknown message role: ${(_exhaustive as { role: string }).role}`
			)
		}
	}
}

/**
 * Convert an array of Messages to TanStack AI ModelMessages.
 */
export function toModelMessages(
	msgs: Message[]
): ModelMessage[] {
	return msgs.map(toModelMessage)
}

// ============================================================================
// Internal converters
// ============================================================================

function userToModelMessage(
	msg: UserMessage
): ModelMessage {
	const content: ContentPart[] = []

	if (msg.speech?.flow === 'transcript-first') {
		content.push({
			type: 'text',
			content:
				'[the following message has been transcribed]'
		})
	}

	for (const c of msg.content) {
		if (c.type === 'text') {
			content.push({ type: 'text', content: c.text })
		} else if (
			c.type === 'image' &&
			'data' in c &&
			c.data
		) {
			// Base64 image (inline or file-reference with embedded data)
			const mimeType =
				('mimeType' in c ? c.mimeType : undefined) ??
				('mime' in c ? (c.mime as string) : 'image/png')
			content.push({
				type: 'image',
				source: {
					type: 'data',
					value: c.data,
					mimeType
				}
			})
		} else if (
			'file' in c &&
			'textContent' in c &&
			c.textContent
		) {
			// Text file with embedded content — inline into conversation
			const name = 'name' in c ? (c.name as string) : 'file'
			const text = c.textContent as string
			const MAX_INLINE = 50_000
			if (text.length > MAX_INLINE) {
				const truncated = text.slice(0, MAX_INLINE)
				const fileRef =
					'file' in c && c.file ? (c.file as string) : ''
				const link = fileRef
					? `\n\n(Content truncated at 50K of ${text.length} chars — full file: /api/uploads-rpc/${fileRef}/content)`
					: `\n\n(Content truncated at 50K of ${text.length} chars)`
				content.push({
					type: 'text',
					content: `--- ${name} ---\n${truncated}${link}`
				})
			} else {
				content.push({
					type: 'text',
					content: `--- ${name} ---\n${text}`
				})
			}
		} else if ('file' in c) {
			// Binary file-reference — describe as text for the model
			const name = 'name' in c ? (c.name as string) : c.type
			content.push({
				type: 'text',
				content: `[Attached ${c.type}: ${name}]`
			})
		}
	}

	return { role: 'user', content }
}

function assistantToModelMessage(
	msg: AssistantMessage
): ModelMessage {
	const textParts = msg.content.filter(
		(c): c is TextContent => c.type === 'text'
	)
	const toolCalls = msg.content.filter(
		(c): c is ToolCall => c.type === 'toolCall'
	)
	// Thinking content is stripped — providers handle it via modelOptions

	const textContent = textParts.map(c => c.text).join('')

	const tanStackToolCalls =
		toolCalls.length > 0
			? toolCalls.map(tc => ({
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

function toolResultToModelMessage(
	msg: ToolResultMessage
): ModelMessage {
	const textContent = msg.content
		.filter((c): c is TextContent => c.type === 'text')
		.map(c => c.text)
		.join('')

	return {
		role: 'tool',
		content: textContent,
		toolCallId: msg.toolCallId
	}
}
