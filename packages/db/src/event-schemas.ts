import * as v from 'valibot'
import type { EventType } from '@ellie/schemas/events'
import {
	speechMetadataSchema,
	channelSourceSchema
} from '@ellie/schemas'

// ── Event types ─────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
	'user_message',
	'agent_start',
	'agent_end',
	'turn_start',
	'turn_end',
	'run_closed',
	'error',
	// Unified streaming events (single row, INSERT then UPDATE)
	'assistant_message',
	'tool_execution',
	// Resilience events
	'retry',
	'context_compacted',
	'tool_loop_detected',
	// Guardrail events
	'limit_hit',
	// Exec-mode events: script_exec
	'script_exec_start',
	'script_exec_end',
	'script_exec_error',
	// Exec-mode events: session_exec
	'session_exec_start',
	'session_exec_commit',
	'session_exec_end',
	'session_exec_snapshot_saved',
	'session_exec_snapshot_restore_skipped',
	'session_exec_error',
	// Memory events
	'memory_recall',
	'memory_retain',
	// Session lifecycle
	'session_rotated',
	// Channel delivery confirmation
	'channel_delivered',
	// Reply-bound artifacts
	'assistant_artifact',
	// Live-text delivery
	'live_delivery'
] as const satisfies readonly EventType[]

export const eventTypeSchema = v.picklist(EVENT_TYPES)

/**
 * Durable session DB policy:
 * keep only the rows needed to rebuild chat history and recover run state.
 * Everything else belongs in the trace journal, not SQLite.
 */
export const DURABLE_EVENT_TYPES = [
	'user_message',
	'assistant_message',
	'tool_execution',
	'agent_start',
	'run_closed',
	'session_rotated',
	'memory_recall',
	'memory_retain',
	'channel_delivered',
	'assistant_artifact',
	'live_delivery'
] as const satisfies readonly EventType[]

const durableEventTypeSet = new Set<EventType>(
	DURABLE_EVENT_TYPES
)

export function isDurableEventType(
	type: EventType
): boolean {
	return durableEventTypeSet.has(type)
}

// ── Per-type payload schemas ────────────────────────────────────────────────

const textContent = v.object({
	type: v.literal('text'),
	text: v.string()
})
const imageContent = v.object({
	type: v.literal('image'),
	data: v.string(),
	mimeType: v.string()
})
const imageFileContent = v.object({
	type: v.literal('image'),
	file: v.string(),
	name: v.optional(v.string()),
	mime: v.optional(v.string()),
	data: v.optional(v.string()),
	mimeType: v.optional(v.string())
})
const videoFileContent = v.object({
	type: v.literal('video'),
	file: v.string(),
	name: v.optional(v.string()),
	mime: v.optional(v.string())
})
const audioFileContent = v.object({
	type: v.literal('audio'),
	file: v.string(),
	name: v.optional(v.string()),
	mime: v.optional(v.string())
})
const fileContent = v.object({
	type: v.literal('file'),
	file: v.string(),
	name: v.optional(v.string()),
	mime: v.optional(v.string()),
	textContent: v.optional(v.string())
})

export const payloadSchemas: Record<
	EventType,
	v.GenericSchema
> = {
	user_message: v.object({
		role: v.literal('user'),
		content: v.array(
			v.union([
				textContent,
				imageContent,
				imageFileContent,
				videoFileContent,
				audioFileContent,
				fileContent
			])
		),
		timestamp: v.number(),
		speech: v.optional(speechMetadataSchema),
		source: v.optional(channelSourceSchema)
	}),
	agent_start: v.object({}),
	agent_end: v.object({
		messages: v.optional(v.array(v.unknown()))
	}),
	turn_start: v.object({}),
	turn_end: v.object({}),
	run_closed: v.object({
		reason: v.optional(v.string())
	}),
	error: v.object({
		message: v.string(),
		code: v.optional(v.string())
	}),
	// Unified streaming events — permissive message schema (evolves during streaming)
	assistant_message: v.object({
		message: v.record(v.string(), v.unknown()),
		streaming: v.boolean(),
		ttsDirective: v.optional(
			v.object({
				params: v.optional(v.string())
			})
		)
	}),
	tool_execution: v.object({
		toolCallId: v.string(),
		toolName: v.string(),
		args: v.unknown(),
		result: v.optional(v.unknown()),
		isError: v.optional(v.boolean()),
		status: v.picklist(['running', 'complete', 'error']),
		sourceAssistantRowId: v.optional(v.number())
	}),
	// Resilience events — permissive schemas for operational data
	retry: v.object({
		attempt: v.number(),
		maxAttempts: v.number(),
		reason: v.string(),
		delayMs: v.number()
	}),
	context_compacted: v.object({
		removedCount: v.number(),
		remainingCount: v.number(),
		estimatedTokens: v.number()
	}),
	tool_loop_detected: v.object({
		pattern: v.string(),
		toolName: v.string(),
		message: v.string()
	}),
	// Guardrail events
	limit_hit: v.object({
		limit: v.picklist([
			'max_wall_clock_ms',
			'max_model_calls',
			'max_cost_usd'
		]),
		threshold: v.number(),
		observed: v.number(),
		usageSnapshot: v.object({
			elapsedMs: v.number(),
			modelCalls: v.number(),
			costUsd: v.number()
		}),
		scope: v.literal('run'),
		action: v.literal('hard_stop')
	}),
	// Exec-mode events: script_exec
	script_exec_start: v.object({
		toolCallId: v.string(),
		scriptLength: v.number()
	}),
	script_exec_end: v.object({
		toolCallId: v.string(),
		success: v.boolean(),
		elapsedMs: v.number(),
		outputLength: v.number()
	}),
	script_exec_error: v.object({
		toolCallId: v.string(),
		code: v.optional(v.string()),
		message: v.string()
	}),
	// Exec-mode events: session_exec
	session_exec_start: v.object({
		toolCallId: v.string(),
		sessionId: v.string(),
		codeLength: v.number()
	}),
	session_exec_commit: v.object({
		toolCallId: v.string(),
		sessionId: v.string(),
		committedLength: v.number()
	}),
	session_exec_end: v.object({
		toolCallId: v.string(),
		sessionId: v.string(),
		success: v.boolean(),
		elapsedMs: v.number(),
		hasArtifacts: v.boolean()
	}),
	session_exec_snapshot_saved: v.object({
		sessionId: v.string(),
		workspaceDir: v.string(),
		gitHead: v.optional(v.nullable(v.string()))
	}),
	session_exec_snapshot_restore_skipped: v.object({
		sessionId: v.string(),
		reason: v.string()
	}),
	session_exec_error: v.object({
		toolCallId: v.string(),
		sessionId: v.optional(v.string()),
		message: v.string()
	}),
	// Memory events
	memory_recall: v.object({
		parts: v.array(
			v.object({
				type: v.literal('memory'),
				text: v.string(),
				count: v.number(),
				memories: v.optional(
					v.array(
						v.object({
							text: v.string(),
							model: v.optional(v.string())
						})
					)
				),
				duration_ms: v.optional(v.number())
			})
		),
		query: v.string(),
		bankIds: v.array(v.string()),
		searchResults: v.optional(
			v.array(
				v.object({
					bankId: v.string(),
					status: v.picklist(['ok', 'error', 'timeout']),
					error: v.optional(v.string()),
					memoryCount: v.number(),
					methodResults: v.optional(
						v.record(
							v.string(),
							v.object({
								hits: v.array(
									v.object({
										id: v.string(),
										score: v.number()
									})
								),
								error: v.optional(v.string())
							})
						)
					)
				})
			)
		),
		timestamp: v.number()
	}),
	// Session lifecycle
	session_rotated: v.object({
		previousSessionId: v.string(),
		message: v.string()
	}),
	// Channel delivery checkpoint (per outbound item)
	channel_delivered: v.object({
		channelId: v.string(),
		accountId: v.string(),
		conversationId: v.string(),
		assistantRowId: v.number(),
		replyIndex: v.number(),
		payloadIndex: v.number(),
		attachmentIndex: v.number(),
		kind: v.picklist(['message', 'media', 'audio_voice']),
		deliveredAt: v.number()
	}),
	memory_retain: v.object({
		parts: v.array(
			v.object({
				type: v.literal('memory-retain'),
				factsStored: v.number(),
				facts: v.array(v.string()),
				model: v.optional(v.string()),
				duration_ms: v.optional(v.number())
			})
		),
		trigger: v.picklist([
			'turn_count',
			'char_count',
			'immediate_turn'
		]),
		bankIds: v.array(v.string()),
		seqFrom: v.number(),
		seqTo: v.number(),
		timestamp: v.number()
	}),
	// Reply-bound artifacts
	assistant_artifact: v.object({
		assistantRowId: v.number(),
		kind: v.picklist(['media', 'audio', 'file']),
		origin: v.picklist([
			'tool_upload',
			'tts',
			'llm_directive'
		]),
		uploadId: v.string(),
		url: v.optional(v.string()),
		mime: v.optional(v.string()),
		size: v.optional(v.number()),
		synthesizedText: v.optional(v.string())
	}),
	// Live-text delivery checkpoint
	live_delivery: v.object({
		channelId: v.string(),
		accountId: v.string(),
		conversationId: v.string(),
		assistantRowId: v.number(),
		handle: v.record(v.string(), v.unknown()),
		status: v.picklist([
			'streaming',
			'finalized',
			'failed'
		]),
		lastSentText: v.string(),
		updatedAt: v.number()
	})
}
