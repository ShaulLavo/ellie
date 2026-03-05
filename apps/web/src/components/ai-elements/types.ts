/**
 * Local type definitions for ai-elements components.
 * Replaces types previously imported from the "ai" package.
 */

// -- Message types --

export interface UIMessage {
	role: 'user' | 'assistant' | 'system'
	content: string
	parts?: unknown[]
}

// -- Tool types --

export interface Tool {
	description?: string
	jsonSchema?: Record<string, unknown>
	inputSchema?: Record<string, unknown>
}

export type ToolUIPartState =
	| 'input-streaming'
	| 'input-available'
	| 'output-available'
	| 'output-error'
	| 'output-denied'
	| 'approval-requested'
	| 'approval-responded'

export interface ToolUIPart {
	type: string
	state: ToolUIPartState
	input?: unknown
	output?: unknown
	errorText?: string
}

export interface DynamicToolUIPart {
	type: 'dynamic-tool'
	state: ToolUIPartState
	toolName: string
	input?: unknown
	output?: unknown
	errorText?: string
}

// -- Chat status --

export type ChatStatus =
	| 'submitted'
	| 'streaming'
	| 'ready'
	| 'error'

// -- File / Source types --

export interface FileUIPart {
	type: 'file'
	filename?: string
	mediaType?: string
	url?: string
}

export interface SourceDocumentUIPart {
	type: 'source-document'
	title?: string
	filename?: string
	mediaType?: string
	sourceId?: string
	url?: string
}

// -- Usage types --

export interface LanguageModelUsage {
	inputTokens?: number
	outputTokens?: number
	reasoningTokens?: number
	cachedInputTokens?: number
	totalTokens?: number
}

// -- Experimental types --

export interface Experimental_GeneratedImage {
	base64: string
	uint8Array?: Uint8Array
	mediaType: string
}

export interface Experimental_SpeechResult {
	audio: {
		mediaType: string
		base64: string
	}
}

export interface Experimental_TranscriptionResult {
	text: string
	segments: {
		text: string
		startSecond: number
		endSecond: number
	}[]
}
