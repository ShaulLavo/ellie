import type { Model, ThinkingLevel } from '@ellie/ai'
import type {
	ModelMessage,
	StreamChunk,
	Tool as TanStackTool,
	AnyTextAdapter
} from '@tanstack/ai'
import type { GenericSchema, InferOutput } from 'valibot'

// ============================================================================
// Schema-derived types (single source of truth: @ellie/schemas/agent)
// ============================================================================

export type {
	TextContent,
	ThinkingContent,
	ImageContent,
	ToolCall,
	StopReason,
	UserMessage,
	AssistantMessage,
	ToolResultMessage,
	AgentMessage,
	AssistantStreamEvent,
	AgentEvent
} from '@ellie/schemas/agent'

import type {
	TextContent,
	ImageContent,
	AgentMessage,
	AgentEvent
} from '@ellie/schemas/agent'

export type Message = AgentMessage

// ============================================================================
// Tools
// ============================================================================

export interface AgentToolResult<TDetails = unknown> {
	content: (TextContent | ImageContent)[]
	details: TDetails
}

export type AgentToolUpdateCallback<TDetails = unknown> = (
	partialResult: AgentToolResult<TDetails>
) => void

export interface AgentTool<
	TParameters extends GenericSchema = GenericSchema,
	TDetails = unknown
> {
	name: string
	description: string
	parameters: TParameters
	label: string
	execute: (
		toolCallId: string,
		params: InferOutput<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>
	) => Promise<AgentToolResult<TDetails>>
}

// ============================================================================
// Agent state & context
// ============================================================================

export interface AgentState {
	systemPrompt: string
	model: Model
	thinkingLevel: ThinkingLevel | 'off'
	tools: AgentTool[]
	messages: AgentMessage[]
	isStreaming: boolean
	streamMessage: AgentMessage | null
	error?: string
}

export interface AgentContext {
	systemPrompt: string
	messages: AgentMessage[]
	tools?: AgentTool[]
}

// ============================================================================
// Guardrail policy
// ============================================================================

export interface AgentRuntimeLimits {
	/** Maximum wall-clock time in milliseconds. Disabled when unset, 0, or negative. */
	maxWallClockMs?: number
	/** Maximum model invocation attempts (including retries). Disabled when unset, 0, or negative. */
	maxModelCalls?: number
	/** Maximum accumulated USD cost for the run. Disabled when unset, 0, or negative. */
	maxCostUsd?: number
}

export interface AgentGuardrailPolicy {
	/** Runtime hard limits for a single run. */
	runtimeLimits?: AgentRuntimeLimits
}

// ============================================================================
// Stream function & loop config
// ============================================================================

export interface StreamCallOptions {
	adapter: AnyTextAdapter
	messages: ModelMessage[]
	systemPrompts?: string[]
	tools?: TanStackTool[]
	modelOptions?: Record<string, unknown>
	temperature?: number
	maxTokens?: number
	abortController?: AbortController
}

export type StreamFn = (
	options: StreamCallOptions
) => AsyncIterable<StreamChunk>

export interface AgentLoopConfig {
	model: Model
	adapter: AnyTextAdapter
	thinkingLevel?: ThinkingLevel | 'off'
	temperature?: number
	maxTokens?: number

	/** Maximum LLM call iterations when tools are involved. Default: 10 */
	maxTurns?: number

	transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal
	) => Promise<AgentMessage[]>

	getSteeringMessages?: () => Promise<AgentMessage[]>
	getFollowUpMessages?: () => Promise<AgentMessage[]>

	/** Called alongside EventStream.push() for each event. Use for durable persistence. Must be synchronous. */
	onEvent?: (event: AgentEvent) => void

	/** Tier 2 trace callback — JSONL only, no DB write. Best-effort. */
	onTrace?: (entry: {
		type: string
		payload: unknown
	}) => void

	// --- Resilience config ---

	/** Retry configuration for transient LLM errors. Default: 3 attempts, 1s base, 30s max. */
	retry?: {
		maxAttempts?: number
		baseDelayMs?: number
		maxDelayMs?: number
		backoffMultiplier?: number
	}

	/** Context recovery configuration for overflow errors. Uses model.contextWindow by default. */
	contextRecovery?: {
		safetyMargin?: number
		minPreservedMessages?: number
		charsPerToken?: number
	}

	/** Tool result truncation configuration. Default: 50_000 chars per result. */
	toolSafety?: {
		maxToolResultChars?: number
		/** Directory to write full output when a tool result is truncated. */
		overflowDir?: string
	}

	/** Tool loop detection configuration. */
	toolLoopDetection?: {
		maxRepeatedCalls?: number
		maxPingPongCycles?: number
		historySize?: number
		requireIdenticalResults?: boolean
	}

	/** Runtime hard limits for a single run (guardrail policy). */
	runtimeLimits?: AgentRuntimeLimits
}
