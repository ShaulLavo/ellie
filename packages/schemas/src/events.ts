/**
 * Typed event payloads — keyed discriminated union for EventRow.
 *
 * Maps every event type string to its exact payload shape.
 * Used by the EventStore (creation) and the React client (consumption)
 * so TypeScript enforces correct payloads at both ends.
 *
 * All persistence uses unified types only:
 *   - assistant_message (single row, INSERT then UPDATE)
 *   - tool_execution (single row, INSERT then UPDATE)
 *   - user_message (append-only)
 */

import type {
	AgentMessage,
	AssistantMessage,
	UserMessage
} from './agent'
import type { ContentPart } from './chat'

export interface EventPayloadMap {
	// --- Core messages ---
	user_message: UserMessage

	// --- Unified streaming events (single row, INSERT then UPDATE) ---
	assistant_message: {
		message: AssistantMessage
		streaming: boolean
		/** Structured TTS directive (compiled from [[tts:...]] at message_end). */
		ttsDirective?: { params?: string }
	}
	tool_execution: {
		toolCallId: string
		toolName: string
		args: unknown
		result?: {
			content: Array<
				| { type: 'text'; text: string }
				| { type: 'image'; data: string; mimeType: string }
			>
			details: unknown
		}
		isError?: boolean
		status: 'running' | 'complete' | 'error'
		elapsedMs?: number
		/** Row ID of the assistant message that triggered this tool execution. */
		sourceAssistantRowId?: number
	}

	// --- Reply-bound artifacts (media, audio, files) ---
	assistant_artifact: {
		assistantRowId: number
		kind: 'media' | 'audio' | 'file'
		origin: 'tool_upload' | 'tts' | 'llm_directive'
		uploadId: string
		url?: string
		mimeType?: string
		size?: number
		width?: number
		height?: number
		hash?: string
		synthesizedText?: string
	}

	// --- Agent lifecycle ---
	agent_start: Record<string, never>
	agent_end: { messages?: AgentMessage[] }
	turn_start: Record<string, never>
	turn_end: Record<string, never>
	run_closed: { reason?: string }

	// --- Resilience ---
	retry: {
		attempt: number
		maxAttempts: number
		reason: string
		delayMs: number
	}
	context_compacted: {
		removedCount: number
		remainingCount: number
		estimatedTokens: number
	}
	tool_loop_detected: {
		pattern: string
		toolName: string
		message: string
	}

	// --- Guardrail ---
	limit_hit: {
		limit:
			| 'max_wall_clock_ms'
			| 'max_model_calls'
			| 'max_cost_usd'
		threshold: number
		observed: number
		usageSnapshot: {
			elapsedMs: number
			modelCalls: number
			costUsd: number
		}
		scope: 'run'
		action: 'hard_stop'
	}

	// --- Memory ---
	memory_recall: {
		parts: ContentPart[]
		query: string
		bankIds: string[]
		searchResults?: Array<{
			bankId: string
			status: 'ok' | 'error' | 'timeout'
			error?: string
			memoryCount: number
			methodResults?: Record<
				string,
				{
					hits: Array<{ id: string; score: number }>
					error?: string
				}
			>
		}>
		timestamp: number
	}
	memory_retain: {
		parts: ContentPart[]
		trigger: string
		bankIds: string[]
		seqFrom: number
		seqTo: number
		timestamp: number
	}

	// --- Code execution: script_exec ---
	script_exec_start: {
		toolCallId: string
		scriptLength: number
	}
	script_exec_end: {
		toolCallId: string
		success: boolean
		elapsedMs: number
		outputLength: number
	}
	script_exec_error: {
		toolCallId: string
		code?: string
		message: string
	}

	// --- Code execution: session_exec ---
	session_exec_start: {
		toolCallId: string
		sessionId: string
		codeLength: number
	}
	session_exec_commit: {
		toolCallId: string
		sessionId: string
		committedLength: number
	}
	session_exec_end: {
		toolCallId: string
		sessionId: string
		success: boolean
		elapsedMs: number
		hasArtifacts: boolean
	}
	session_exec_snapshot_saved: {
		sessionId: string
		workspaceDir: string
		gitHead?: string | null
	}
	session_exec_snapshot_restore_skipped: {
		sessionId: string
		reason: string
	}
	session_exec_error: {
		toolCallId: string
		sessionId?: string
		message: string
	}

	// --- Session lifecycle ---
	session_rotated: {
		previousSessionId: string
		message: string
	}

	// --- Error ---
	error: { message: string; code?: string }

	// --- Channel delivery checkpoint (per outbound item) ---
	channel_delivered: {
		channelId: string
		accountId: string
		conversationId: string
		assistantRowId: number
		replyIndex: number
		payloadIndex: number
		attachmentIndex: number
		kind: 'message' | 'media' | 'audio_voice'
		deliveredAt: number
	}

	// --- Live-text delivery checkpoint (separate from channel_delivered) ---
	live_delivery: {
		channelId: string
		accountId: string
		conversationId: string
		assistantRowId: number
		handle: Record<string, unknown>
		status: 'streaming' | 'finalized' | 'failed'
		lastSentText: string
		updatedAt: number
	}
}

/** Union of all valid event type strings. */
export type EventType = keyof EventPayloadMap

/** Discriminated union: type + payload paired together. */
export type TypedEvent = {
	[K in EventType]: { type: K; payload: EventPayloadMap[K] }
}[EventType]

/** Full parsed event row (DB metadata + typed event). */
export type ParsedEventRow = {
	id: number
	sessionId: string
	seq: number
	runId: string | null
	dedupeKey: string | null
	createdAt: number
} & TypedEvent
