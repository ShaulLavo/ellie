// Core Agent
export { Agent } from "./agent";
export type { AgentOptions } from "./agent";

// Loop functions
export { agentLoop, agentLoopContinue } from "./agent-loop";

// Event stream
export { EventStream } from "./event-stream";

// Message conversion
export {
	toModelMessage,
	toModelMessages,
	convertAgentToolsToTanStack,
} from "./messages";

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
	toolCallSchema,
} from "./schemas";

// Type guards
export { isMessage, isAssistantMessage } from "./types";

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
	CustomAgentMessages,
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
	AgentLoopConfig,
} from "./types";
