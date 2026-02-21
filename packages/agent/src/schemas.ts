/**
 * Re-export all schemas from @ellie/schemas.
 * This file exists for backwards compatibility — consumers
 * should prefer importing from @ellie/schemas directly.
 */
export {
	agentMessageSchema,
	agentEventSchema,
	userMessageSchema,
	assistantMessageSchema,
	toolResultMessageSchema,
	textContentSchema,
	thinkingContentSchema,
	imageContentSchema,
	toolCallSchema,
} from "@ellie/schemas";
