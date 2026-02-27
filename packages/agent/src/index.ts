// Core Agent
export { Agent } from './agent'
export type { AgentOptions } from './agent'

// Loop functions
export { agentLoop, agentLoopContinue } from './agent-loop'

// Event stream
export { EventStream } from './event-stream'

// Message conversion
export { toModelMessage, toModelMessages } from './messages'

// Schemas (for JSONL persistence)
export {
	agentMessageSchema,
	agentEventSchema,
	userMessageSchema,
	assistantMessageSchema,
	toolResultMessageSchema,
	textContentSchema,
	thinkingContentSchema,
	imageContentSchema,
	toolCallSchema
} from './schemas'

// Resilience modules
export { withRetry } from './retry'
export type { RetryOptions } from './retry'
export {
	trimMessages,
	estimateTokens
} from './context-recovery'
export type { ContextRecoveryOptions } from './context-recovery'
export { truncateToolResult } from './tool-safety'
export type { ToolSafetyOptions } from './tool-safety'
export { createToolLoopDetector } from './tool-loop-detection'
export type { ToolLoopDetector } from './tool-loop-detection'

// Types
export type {
	// Content blocks
	TextContent,
	ThinkingContent,
	ImageContent,
	ToolCall,

	// Messages
	StopReason,
	UserMessage,
	AssistantMessage,
	ToolResultMessage,
	Message,
	AgentMessage,

	// Tools
	AgentToolResult,
	AgentToolUpdateCallback,
	AgentTool,

	// State & context
	AgentState,
	AgentContext,

	// Stream events
	AssistantStreamEvent,
	AgentEvent,

	// Loop config
	StreamCallOptions,
	StreamFn,
	AgentLoopConfig
} from './types'
