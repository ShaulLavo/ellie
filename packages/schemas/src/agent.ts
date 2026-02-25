/**
 * Valibot schemas for serializing AgentMessage and AgentEvent to/from JSON.
 * Used by TypedLog / DurableStore for JSONL persistence.
 */

import * as v from 'valibot'

// ============================================================================
// Content block schemas
// ============================================================================

export const textContentSchema = v.object({
	type: v.literal('text'),
	text: v.string()
})

export const thinkingContentSchema = v.object({
	type: v.literal('thinking'),
	thinking: v.string()
})

export const imageContentSchema = v.object({
	type: v.literal('image'),
	data: v.string(),
	mimeType: v.string()
})

export const toolCallSchema = v.object({
	type: v.literal('toolCall'),
	id: v.string(),
	name: v.string(),
	arguments: v.record(v.string(), v.unknown())
})

// ============================================================================
// Usage / cost schemas
// ============================================================================

const costSchema = v.object({
	input: v.number(),
	output: v.number(),
	cacheRead: v.number(),
	cacheWrite: v.number(),
	total: v.number()
})

const usageSchema = v.object({
	input: v.number(),
	output: v.number(),
	cacheRead: v.number(),
	cacheWrite: v.number(),
	totalTokens: v.number(),
	cost: costSchema
})

// ============================================================================
// Message schemas
// ============================================================================

export const userMessageSchema = v.object({
	role: v.literal('user'),
	content: v.array(v.variant('type', [textContentSchema, imageContentSchema])),
	timestamp: v.number()
})

export const assistantMessageSchema = v.object({
	role: v.literal('assistant'),
	content: v.array(v.variant('type', [textContentSchema, thinkingContentSchema, toolCallSchema])),
	provider: v.string(),
	model: v.string(),
	usage: usageSchema,
	stopReason: v.picklist(['stop', 'length', 'toolUse', 'error', 'aborted']),
	errorMessage: v.optional(v.string()),
	timestamp: v.number()
})

export const toolResultMessageSchema = v.object({
	role: v.literal('toolResult'),
	toolCallId: v.string(),
	toolName: v.string(),
	content: v.array(v.variant('type', [textContentSchema, imageContentSchema])),
	details: v.optional(v.unknown()),
	isError: v.boolean(),
	timestamp: v.number()
})

/**
 * Schema for any AgentMessage (discriminated on `role`).
 * Use this with TypedLog for JSONL persistence.
 */
export const agentMessageSchema = v.variant('role', [
	userMessageSchema,
	assistantMessageSchema,
	toolResultMessageSchema
])

// ── Inferred types (canonical message types for cross-package use) ──────────

export type UserMessage = v.InferOutput<typeof userMessageSchema>
export type AssistantMessage = v.InferOutput<typeof assistantMessageSchema>
export type ToolResultMessage = v.InferOutput<typeof toolResultMessageSchema>
export type AgentMessage = v.InferOutput<typeof agentMessageSchema>

// ============================================================================
// Agent action procedure schemas
// ============================================================================

export const agentPromptInputSchema = v.object({
	message: v.string()
})
export type AgentPromptInput = v.InferOutput<typeof agentPromptInputSchema>

export const agentPromptOutputSchema = v.object({
	runId: v.string(),
	sessionId: v.string(),
	status: v.literal('started')
})
export type AgentPromptOutput = v.InferOutput<typeof agentPromptOutputSchema>

export const agentSteerInputSchema = v.object({
	message: v.string()
})
export type AgentSteerInput = v.InferOutput<typeof agentSteerInputSchema>

export const agentSteerOutputSchema = v.object({
	status: v.literal('queued')
})
export type AgentSteerOutput = v.InferOutput<typeof agentSteerOutputSchema>

export const agentAbortInputSchema = v.undefined_()
export type AgentAbortInput = v.InferOutput<typeof agentAbortInputSchema>

export const agentAbortOutputSchema = v.object({
	status: v.literal('aborted')
})
export type AgentAbortOutput = v.InferOutput<typeof agentAbortOutputSchema>

export const agentHistoryInputSchema = v.undefined_()
export type AgentHistoryInput = v.InferOutput<typeof agentHistoryInputSchema>

export const agentHistoryOutputSchema = v.object({
	messages: v.array(agentMessageSchema)
})
export type AgentHistoryOutput = v.InferOutput<typeof agentHistoryOutputSchema>

// ============================================================================
// Agent event schemas
// ============================================================================

const agentStartEventSchema = v.object({ type: v.literal('agent_start') })

const agentEndEventSchema = v.object({
	type: v.literal('agent_end'),
	messages: v.array(agentMessageSchema)
})

const turnStartEventSchema = v.object({ type: v.literal('turn_start') })

const turnEndEventSchema = v.object({
	type: v.literal('turn_end'),
	message: agentMessageSchema,
	toolResults: v.array(toolResultMessageSchema)
})

const messageStartEventSchema = v.object({
	type: v.literal('message_start'),
	message: agentMessageSchema
})

// Stream event sub-schemas for message_update
const assistantStreamEventSchema = v.variant('type', [
	v.object({ type: v.literal('text_start'), contentIndex: v.number() }),
	v.object({
		type: v.literal('text_delta'),
		contentIndex: v.number(),
		delta: v.string()
	}),
	v.object({ type: v.literal('text_end'), contentIndex: v.number() }),
	v.object({ type: v.literal('thinking_start'), contentIndex: v.number() }),
	v.object({
		type: v.literal('thinking_delta'),
		contentIndex: v.number(),
		delta: v.string()
	}),
	v.object({ type: v.literal('thinking_end'), contentIndex: v.number() }),
	v.object({ type: v.literal('toolcall_start'), contentIndex: v.number() }),
	v.object({
		type: v.literal('toolcall_delta'),
		contentIndex: v.number(),
		delta: v.string()
	}),
	v.object({
		type: v.literal('toolcall_end'),
		contentIndex: v.number(),
		toolCall: toolCallSchema
	})
])

const messageUpdateEventSchema = v.object({
	type: v.literal('message_update'),
	message: agentMessageSchema,
	streamEvent: assistantStreamEventSchema
})

const messageEndEventSchema = v.object({
	type: v.literal('message_end'),
	message: agentMessageSchema
})

const toolExecutionResultSchema = v.object({
	content: v.array(v.variant('type', [textContentSchema, imageContentSchema])),
	details: v.unknown()
})

const toolExecutionStartEventSchema = v.object({
	type: v.literal('tool_execution_start'),
	toolCallId: v.string(),
	toolName: v.string(),
	args: v.unknown()
})

const toolExecutionUpdateEventSchema = v.object({
	type: v.literal('tool_execution_update'),
	toolCallId: v.string(),
	toolName: v.string(),
	args: v.unknown(),
	partialResult: toolExecutionResultSchema
})

const toolExecutionEndEventSchema = v.object({
	type: v.literal('tool_execution_end'),
	toolCallId: v.string(),
	toolName: v.string(),
	result: toolExecutionResultSchema,
	isError: v.boolean()
})

/**
 * Schema for any AgentEvent (discriminated on `type`).
 * Use this with TypedLog for JSONL persistence of lifecycle events.
 */
export const agentEventSchema = v.variant('type', [
	agentStartEventSchema,
	agentEndEventSchema,
	turnStartEventSchema,
	turnEndEventSchema,
	messageStartEventSchema,
	messageUpdateEventSchema,
	messageEndEventSchema,
	toolExecutionStartEventSchema,
	toolExecutionUpdateEventSchema,
	toolExecutionEndEventSchema
])
