import type { Model, Usage, ProviderName, ThinkingLevel } from "@ellie/ai";
import type {
	ModelMessage,
	StreamChunk,
	Tool as TanStackTool,
	AnyTextAdapter,
} from "@tanstack/ai";
import type { GenericSchema, InferOutput } from "valibot";

// ============================================================================
// Content blocks
// ============================================================================

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

// ============================================================================
// Messages
// ============================================================================

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	provider: ProviderName;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ============================================================================
// Custom agent messages (declaration merging)
// ============================================================================

/**
 * Apps extend via declaration merging:
 *
 * ```typescript
 * declare module "@ellie/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: declaration merging target
export interface CustomAgentMessages {}

export type AgentMessage =
	| Message
	| CustomAgentMessages[keyof CustomAgentMessages];

// ============================================================================
// Type guards
// ============================================================================

/** Narrow AgentMessage to Message (user | assistant | toolResult). */
export function isMessage(m: AgentMessage): m is Message {
	if (m.role === "user" || m.role === "toolResult") return true;
	if (m.role === "assistant" && "provider" in m) return true;
	return false;
}

/** Narrow AgentMessage to AssistantMessage. Uses `"provider" in m` to distinguish from custom messages. */
export function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && "provider" in m;
}

// ============================================================================
// Tools
// ============================================================================

export interface AgentToolResult<TDetails = unknown> {
	content: (TextContent | ImageContent)[];
	details: TDetails;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (
	partialResult: AgentToolResult<TDetails>,
) => void;

export interface AgentTool<
	TParameters extends GenericSchema = GenericSchema,
	TDetails = unknown,
> {
	name: string;
	description: string;
	parameters: TParameters;
	label: string;
	execute: (
		toolCallId: string,
		params: InferOutput<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}

// ============================================================================
// Agent state & context
// ============================================================================

export interface AgentState {
	systemPrompt: string;
	model: Model;
	thinkingLevel: ThinkingLevel | "off";
	tools: AgentTool<any>[];
	messages: AgentMessage[];
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

// ============================================================================
// Stream events (assistant message streaming)
// ============================================================================

export type AssistantStreamEvent =
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number }
	| { type: "toolcall_start"; contentIndex: number }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: ToolCall;
	  };

// ============================================================================
// Agent events (lifecycle)
// ============================================================================

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| {
			type: "turn_end";
			message: AgentMessage;
			toolResults: ToolResultMessage[];
	  }
	| { type: "message_start"; message: AgentMessage }
	| {
			type: "message_update";
			message: AgentMessage;
			streamEvent: AssistantStreamEvent;
	  }
	| { type: "message_end"; message: AgentMessage }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult;
			isError: boolean;
	  };

// ============================================================================
// Stream function & loop config
// ============================================================================

export interface StreamCallOptions {
	adapter: AnyTextAdapter;
	messages: ModelMessage[];
	systemPrompts?: string[];
	tools?: TanStackTool[];
	modelOptions?: Record<string, unknown>;
	temperature?: number;
	maxTokens?: number;
	abortController?: AbortController;
}

export type StreamFn = (
	options: StreamCallOptions,
) => AsyncIterable<StreamChunk>;

export interface AgentLoopConfig {
	model: Model;
	adapter: AnyTextAdapter;
	thinkingLevel?: ThinkingLevel | "off";
	temperature?: number;
	maxTokens?: number;

	convertToLlm: (
		messages: AgentMessage[],
	) => ModelMessage[] | Promise<ModelMessage[]>;

	transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
	) => Promise<AgentMessage[]>;

	getSteeringMessages?: () => Promise<AgentMessage[]>;
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/** Called alongside EventStream.push() for each event. Use for durable persistence. */
	onEvent?: (event: AgentEvent) => void | Promise<void>;
}
