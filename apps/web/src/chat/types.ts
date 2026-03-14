import type {
	ContentPart,
	MessageSender
} from '@ellie/schemas/chat'

/**
 * Canonical client-side message type stored in the React Query cache.
 * Uses ISO string for timestamp (Date objects don't survive structured clone).
 */
export interface StoredChatMessage {
	id: string
	timestamp: string
	text: string
	parts: ContentPart[]
	seq: number
	sender?: MessageSender
	isStreaming?: boolean
	streamGroupId?: string
	thinking?: string
	runId?: string | null
	/** Source event type (e.g. 'assistant_message', 'tool_execution', 'assistant_artifact'). */
	eventType?: string
	/** Row ID of the parent assistant reply (for tools and artifacts). */
	parentMessageId?: string
}
