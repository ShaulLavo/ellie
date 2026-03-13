import type { ContentPart } from '@ellie/schemas/chat'

export function partHasVisibleOutput(
	part: ContentPart,
	consumedToolCallIds?: Set<string>
): boolean {
	switch (part.type) {
		case 'text':
			return part.text.trim().length > 0
		case 'tool-call':
			// Hide streaming tool-call placeholders in the assistant
			// message once a real tool_execution result exists.
			return !(
				part.streaming &&
				part.toolCallId &&
				consumedToolCallIds?.has(part.toolCallId)
			)
		case 'image':
		case 'video':
		case 'audio':
			return !!part.url
		default:
			return true
	}
}
