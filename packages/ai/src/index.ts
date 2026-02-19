// ============================================================================
// @ellie/ai - Thin layer on top of TanStack AI
// ============================================================================

// --- Our additions (what TanStack AI doesn't provide) ---

// Core types
export type {
	ProviderName,
	Model,
	ModelInputType,
	ModelCost,
	Usage,
	CostBreakdown,
	ThinkingLevel,
} from "./types";

// Provider constants
export { PROVIDERS } from "./providers";
export type { ProviderInfo } from "./providers";

// Model registry
export {
	getModel,
	getModels,
	getProviders,
	findModel,
	modelsAreEqual,
	MODELS,
} from "./models/index";

// Usage & cost calculation
export { calculateCost, createUsage, mapTanStackUsage } from "./usage";

// Context overflow detection
export { isContextOverflow, getOverflowPatterns } from "./overflow";

// Environment API key resolution
export { getEnvApiKey, hasEnvApiKey } from "./env";

// Thinking level abstraction
export { toThinkingModelOptions, supportsThinking } from "./thinking";

// --- TanStack AI re-exports (convenience) ---

// Core activity functions
export { chat, summarize } from "@tanstack/ai";
export { createChatOptions } from "@tanstack/ai";

// Stream utilities
export {
	streamToText,
	toServerSentEventsStream,
	toServerSentEventsResponse,
	toHttpStream,
	toHttpResponse,
} from "@tanstack/ai";

// Tool definition
export { toolDefinition } from "@tanstack/ai";
export { ToolCallManager } from "@tanstack/ai";

// Agent loop strategies
export {
	maxIterations,
	untilFinishReason,
	combineStrategies,
} from "@tanstack/ai";

// Adapter extension
export { createModel, extendAdapter } from "@tanstack/ai";

// Message utilities
export {
	convertMessagesToModelMessages,
	generateMessageId,
	uiMessageToModelMessages,
	modelMessageToUIMessage,
	modelMessagesToUIMessages,
	normalizeToUIMessage,
} from "@tanstack/ai";

// Stream processing
export { StreamProcessor, createReplayStream } from "@tanstack/ai";

// Utility
export { detectImageMimeType } from "@tanstack/ai";

// --- TanStack AI type re-exports ---
export type {
	// Adapters
	AnyTextAdapter,
	TextAdapter,
	AnyImageAdapter,
	ImageAdapter,

	// Tool types
	ToolDefinition,
	ToolDefinitionInstance,
	ToolDefinitionConfig,
	ServerTool,
	ClientTool,
	AnyClientTool,

	// Schema
	SchemaInput,
	JSONSchema,

	// Adapter extension
	ExtendedModelDef,

	// Stream processing
	ChunkStrategy,
	StreamProcessorOptions,
	StreamProcessorEvents,
	ProcessorResult,
	ProcessorState,
} from "@tanstack/ai";


export * from '@tanstack/ai';