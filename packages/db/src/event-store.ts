import { join } from 'path'
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNotNull,
	lte,
	notExists,
	sql
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as v from 'valibot'
import type { Database } from 'bun:sqlite'
import { ulid } from 'fast-ulid'
import { openDatabase } from './init'
import { AuditLogger } from './audit-log'
import * as schema from './schema'
import {
	sessions,
	events,
	agentBootstrapState,
	kv,
	type SessionRow,
	type EventRow,
	type AgentBootstrapStateRow
} from './schema'
import type { AgentMessage } from '@ellie/schemas'
import type {
	EventType,
	EventPayloadMap
} from '@ellie/schemas/events'

export type { AgentMessage, EventType }

// ── Event types ─────────────────────────────────────────────────────────────

const EVENT_TYPES = [
	'user_message',
	'assistant_start',
	'assistant_final',
	'tool_call',
	'tool_result',
	'agent_start',
	'agent_end',
	'turn_start',
	'turn_end',
	'run_closed',
	'error',
	// Unified streaming events (single row, INSERT then UPDATE)
	'assistant_message',
	'tool_execution',
	// Legacy streaming / lifecycle events (kept for reading old data)
	'message_start',
	'message_update',
	'message_end',
	'tool_execution_start',
	'tool_execution_update',
	'tool_execution_end',
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
	'memory_retain'
] as const satisfies readonly EventType[]

const eventTypeSchema = v.picklist(EVENT_TYPES)

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
const thinkingContent = v.object({
	type: v.literal('thinking'),
	text: v.string()
})
const toolCallContent = v.object({
	type: v.literal('toolCall'),
	id: v.string(),
	name: v.string(),
	arguments: v.record(v.string(), v.unknown())
})

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

const payloadSchemas: Record<EventType, v.GenericSchema> = {
	user_message: v.object({
		role: v.literal('user'),
		content: v.array(
			v.variant('type', [textContent, imageContent])
		),
		timestamp: v.number()
	}),
	assistant_start: v.object({
		role: v.literal('assistant'),
		timestamp: v.number()
	}),
	assistant_final: v.object({
		role: v.literal('assistant'),
		content: v.array(
			v.variant('type', [
				textContent,
				thinkingContent,
				toolCallContent
			])
		),
		provider: v.string(),
		model: v.string(),
		usage: usageSchema,
		stopReason: v.picklist([
			'stop',
			'length',
			'toolUse',
			'error',
			'aborted'
		]),
		errorMessage: v.optional(v.string()),
		timestamp: v.number()
	}),
	tool_call: v.object({
		id: v.string(),
		name: v.string(),
		arguments: v.record(v.string(), v.unknown())
	}),
	tool_result: v.object({
		role: v.literal('toolResult'),
		toolCallId: v.string(),
		toolName: v.string(),
		content: v.array(
			v.variant('type', [textContent, imageContent])
		),
		details: v.optional(v.unknown()),
		isError: v.boolean(),
		timestamp: v.number()
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
		streaming: v.boolean()
	}),
	tool_execution: v.object({
		toolCallId: v.string(),
		toolName: v.string(),
		args: v.unknown(),
		result: v.optional(v.unknown()),
		isError: v.optional(v.boolean()),
		status: v.picklist(['running', 'complete', 'error'])
	}),
	// Legacy streaming — loose schemas (kept for reading old data)
	message_start: v.record(v.string(), v.unknown()),
	message_update: v.record(v.string(), v.unknown()),
	message_end: v.record(v.string(), v.unknown()),
	tool_execution_start: v.object({
		toolCallId: v.string(),
		toolName: v.string(),
		args: v.unknown()
	}),
	tool_execution_update: v.object({
		toolCallId: v.string(),
		toolName: v.string(),
		args: v.unknown(),
		partialResult: v.unknown()
	}),
	tool_execution_end: v.object({
		toolCallId: v.string(),
		toolName: v.string(),
		result: v.unknown(),
		isError: v.boolean()
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
	})
}

// ── Input/output types ──────────────────────────────────────────────────────

export interface AppendInput<
	T extends EventType = EventType
> {
	sessionId: string
	type: T
	payload: EventPayloadMap[T]
	runId?: string
	dedupeKey?: string
}

export interface QueryInput {
	sessionId: string
	afterSeq?: number
	types?: EventType[]
	runId?: string
	limit?: number
}

// ── Resolved path ───────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(
	import.meta.dir,
	'..',
	'drizzle'
)

// ── EventStore ──────────────────────────────────────────────────────────────

export class EventStore {
	readonly db: ReturnType<typeof drizzle>
	readonly sqlite: Database
	readonly #audit: AuditLogger | null

	get auditLogger(): AuditLogger | null {
		return this.#audit
	}

	constructor(
		dbPath: string,
		auditLogDir?: string,
		migrationsFolder?: string
	) {
		this.sqlite = openDatabase(dbPath)
		this.db = drizzle(this.sqlite, { schema })

		// Run Drizzle migrations
		migrate(this.db, {
			migrationsFolder: migrationsFolder ?? MIGRATIONS_DIR
		})

		this.#audit = auditLogDir
			? new AuditLogger(auditLogDir)
			: null
	}

	// ── Session CRUD ────────────────────────────────────────────────────────

	createSession(id?: string): SessionRow {
		const now = Date.now()
		const sessionId = id ?? ulid()

		if (id) {
			const existing = this.getSession(id)
			if (existing)
				throw new Error(`Session already exists: ${id}`)
		}

		return this.db
			.insert(sessions)
			.values({
				id: sessionId,
				createdAt: now,
				updatedAt: now,
				currentSeq: 0
			})
			.returning()
			.get()
	}

	getSession(id: string): SessionRow | undefined {
		return this.db
			.select()
			.from(sessions)
			.where(eq(sessions.id, id))
			.get()
	}

	listSessions(): SessionRow[] {
		return this.db
			.select()
			.from(sessions)
			.orderBy(asc(sessions.createdAt))
			.all()
	}

	deleteSession(id: string): void {
		this.db
			.delete(sessions)
			.where(eq(sessions.id, id))
			.run()
	}

	// ── Event append ────────────────────────────────────────────────────────

	append<T extends EventType>(
		input: AppendInput<T>
	): EventRow {
		// Validate event type
		v.parse(eventTypeSchema, input.type)

		// Validate payload against per-type schema
		const payloadSchema = payloadSchemas[input.type]
		v.parse(payloadSchema, input.payload)

		const payloadJson = JSON.stringify(input.payload)
		const now = Date.now()

		// Run in a Drizzle transaction: load session, bump seq, insert event
		const result = this.db.transaction(tx => {
			// Dedupe check
			if (input.dedupeKey) {
				const existing = tx
					.select()
					.from(events)
					.where(
						and(
							eq(events.sessionId, input.sessionId),
							eq(events.dedupeKey, input.dedupeKey)
						)
					)
					.get()
				if (existing) return existing
			}

			// Load and bump session seq
			const session = tx
				.select()
				.from(sessions)
				.where(eq(sessions.id, input.sessionId))
				.get()
			if (!session) {
				throw new Error(
					`Session not found: ${input.sessionId}`
				)
			}

			const nextSeq = session.currentSeq + 1

			tx.update(sessions)
				.set({ currentSeq: nextSeq, updatedAt: now })
				.where(eq(sessions.id, input.sessionId))
				.run()

			// Insert event and return the inserted row
			const inserted = tx
				.insert(events)
				.values({
					sessionId: input.sessionId,
					seq: nextSeq,
					runId: input.runId ?? null,
					type: input.type,
					payload: payloadJson,
					dedupeKey: input.dedupeKey ?? null,
					createdAt: now
				})
				.returning()
				.get()

			return inserted
		})

		// Best-effort audit
		if (this.#audit) {
			this.#audit.log({
				sessionId: input.sessionId,
				type: input.type,
				seq: result.seq,
				runId: result.runId ?? undefined,
				payload: input.payload,
				ts: now
			})
		}

		return result
	}

	// ── Event update (in-place payload replacement) ─────────────────────────

	/**
	 * Update the payload of an existing event row in place.
	 * Used for streaming: the row is INSERT'd on start, then UPDATE'd
	 * for every delta and at completion. No seq bump — the row keeps
	 * its original position in the event stream.
	 */
	update(id: number, payload: unknown): EventRow {
		const payloadJson = JSON.stringify(payload)

		const result = this.db
			.update(events)
			.set({ payload: payloadJson })
			.where(eq(events.id, id))
			.returning()
			.get()

		if (!result) {
			throw new Error(`Event not found: ${id}`)
		}

		return result
	}

	// ── Event query ─────────────────────────────────────────────────────────

	query(input: QueryInput): EventRow[] {
		const conditions = [
			eq(events.sessionId, input.sessionId)
		]

		if (input.afterSeq !== undefined) {
			conditions.push(gt(events.seq, input.afterSeq))
		}
		if (input.types && input.types.length > 0) {
			conditions.push(inArray(events.type, input.types))
		}
		if (input.runId !== undefined) {
			conditions.push(eq(events.runId, input.runId))
		}

		const base = this.db
			.select()
			.from(events)
			.where(and(...conditions))
			.orderBy(asc(events.seq))

		if (input.limit !== undefined) {
			return base.limit(input.limit).all()
		}

		return base.all()
	}

	// ── History reconstruction ────────────────────────────────────────────

	getConversationHistory(
		sessionId: string
	): AgentMessage[] {
		const rows = this.query({
			sessionId,
			types: [
				'user_message',
				// New unified types
				'assistant_message',
				'tool_execution',
				// Legacy types (for existing data)
				'assistant_final',
				'tool_call',
				'tool_result'
			]
		})

		// Deduplicate: new types take precedence over legacy dual-writes
		const seenToolCallIds = new Set<string>()
		const seenAssistantRuns = new Set<string>()
		for (const row of rows) {
			if (row.type === 'tool_execution') {
				try {
					const d = JSON.parse(row.payload) as {
						toolCallId: string
					}
					seenToolCallIds.add(d.toolCallId)
				} catch {
					/* skip */
				}
			}
			if (row.type === 'assistant_message' && row.runId) {
				seenAssistantRuns.add(row.runId)
			}
		}

		const messages: AgentMessage[] = []
		for (const row of rows) {
			try {
				// Skip legacy rows covered by new unified types
				if (
					(row.type === 'tool_call' ||
						row.type === 'tool_result') &&
					isLegacyToolCovered(row, seenToolCallIds)
				)
					continue
				if (
					row.type === 'assistant_final' &&
					row.runId &&
					seenAssistantRuns.has(row.runId)
				)
					continue

				const msg = parseEventRow(row)
				if (msg) messages.push(msg)
			} catch (err) {
				console.warn(
					`[EventStore] malformed payload in event ${row.id} (seq=${row.seq}):`,
					err
				)
			}
		}
		return reorderToolResults(messages)
	}

	// ── Stale run recovery ────────────────────────────────────────────────

	/**
	 * Find runs that started but never closed within the given time window.
	 *
	 * Note: For large tables, consider adding a composite index:
	 *   CREATE INDEX idx_events_stale_runs ON events(type, run_id, created_at)
	 *     WHERE run_id IS NOT NULL;
	 */
	findStaleRuns(
		maxAgeMs: number
	): Array<{ sessionId: string; runId: string }> {
		const cutoff = Date.now() - maxAgeMs
		const e2 = alias(events, 'e2')

		const closedRuns = this.db
			.select({ id: sql`1` })
			.from(e2)
			.where(
				and(
					eq(e2.sessionId, events.sessionId),
					eq(e2.runId, events.runId),
					eq(e2.type, 'run_closed')
				)
			)

		const rows = this.db
			.selectDistinct({
				sessionId: events.sessionId,
				runId: events.runId
			})
			.from(events)
			.where(
				and(
					isNotNull(events.runId),
					eq(events.type, 'agent_start'),
					lte(events.createdAt, cutoff),
					notExists(closedRuns)
				)
			)
			.all()
		// isNotNull filter above guarantees runId is non-null
		return rows as Array<{
			sessionId: string
			runId: string
		}>
	}

	// ── Bootstrap state ──────────────────────────────────────────────────

	getBootstrapState(
		agentId: string
	): AgentBootstrapStateRow | undefined {
		return this.db
			.select()
			.from(agentBootstrapState)
			.where(eq(agentBootstrapState.agentId, agentId))
			.get()
	}

	markWorkspaceSeededOnce(agentId: string): void {
		const now = Date.now()
		const existing = this.getBootstrapState(agentId)
		if (existing) {
			if (existing.workspaceSeededAt) return // already seeded
			this.db
				.update(agentBootstrapState)
				.set({
					workspaceSeededAt: now,
					status: 'workspace_seeded',
					updatedAt: now
				})
				.where(eq(agentBootstrapState.agentId, agentId))
				.run()
		} else {
			this.db
				.insert(agentBootstrapState)
				.values({
					agentId,
					status: 'workspace_seeded',
					workspaceSeededAt: now,
					updatedAt: now
				})
				.run()
		}
	}

	/**
	 * Atomically claim bootstrap injection for a session.
	 * Returns true if this call won the claim, false if already injected.
	 */
	claimBootstrapInjection(
		agentId: string,
		sessionId: string
	): boolean {
		const now = Date.now()
		return this.db.transaction(tx => {
			const row = tx
				.select()
				.from(agentBootstrapState)
				.where(eq(agentBootstrapState.agentId, agentId))
				.get()

			if (row?.bootstrapInjectedAt) return false

			if (row) {
				tx.update(agentBootstrapState)
					.set({
						bootstrapInjectedAt: now,
						bootstrapInjectedSessionId: sessionId,
						status: 'bootstrap_injected',
						updatedAt: now
					})
					.where(eq(agentBootstrapState.agentId, agentId))
					.run()
			} else {
				tx.insert(agentBootstrapState)
					.values({
						agentId,
						status: 'bootstrap_injected',
						bootstrapInjectedAt: now,
						bootstrapInjectedSessionId: sessionId,
						updatedAt: now
					})
					.run()
			}

			return true
		})
	}

	markBootstrapError(
		agentId: string,
		message: string
	): void {
		const now = Date.now()
		const existing = this.getBootstrapState(agentId)
		if (existing) {
			this.db
				.update(agentBootstrapState)
				.set({
					lastError: message,
					status: 'error',
					updatedAt: now
				})
				.where(eq(agentBootstrapState.agentId, agentId))
				.run()
		} else {
			this.db
				.insert(agentBootstrapState)
				.values({
					agentId,
					status: 'error',
					lastError: message,
					updatedAt: now
				})
				.run()
		}
	}

	// ── Key-Value store ──────────────────────────────────────────────────

	getKv(key: string): string | undefined {
		const row = this.db
			.select()
			.from(kv)
			.where(eq(kv.key, key))
			.get()
		return row?.value
	}

	setKv(key: string, value: string): void {
		this.db
			.insert(kv)
			.values({ key, value })
			.onConflictDoUpdate({
				target: kv.key,
				set: { value }
			})
			.run()
	}

	// ── Cleanup ───────────────────────────────────────────────────────────

	close(): void {
		this.#audit?.close()
		this.sqlite.close()
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse an event row into an AgentMessage, or return null to skip it.
 */
/** Check if a legacy tool_call/tool_result row is covered by a new tool_execution row. */
function isLegacyToolCovered(
	row: EventRow,
	seenToolCallIds: Set<string>
): boolean {
	try {
		const d = JSON.parse(row.payload) as {
			id?: string
			toolCallId?: string
		}
		const tcId = d.id ?? d.toolCallId
		return !!tcId && seenToolCallIds.has(tcId)
	} catch {
		return false
	}
}

/**
 * Parse an event row into an AgentMessage, or return null to skip it.
 */
function parseEventRow(row: EventRow): AgentMessage | null {
	// New unified types
	if (row.type === 'assistant_message') {
		const wrapper = JSON.parse(row.payload) as {
			message: AgentMessage
			streaming: boolean
		}
		if (wrapper.streaming) return null // Skip in-flight messages
		return wrapper.message
	}

	if (row.type === 'tool_execution') {
		const data = JSON.parse(row.payload) as {
			toolCallId: string
			toolName: string
			args: unknown
			result?: {
				content: Array<{
					type: string
					text?: string
					data?: string
					mimeType?: string
				}>
				details: unknown
			}
			isError?: boolean
			status: string
		}
		if (data.status === 'running') return null // Skip in-flight tools
		// Return as toolResult message
		return {
			role: 'toolResult',
			toolCallId: data.toolCallId,
			toolName: data.toolName,
			content: data.result?.content ?? [],
			details: data.result?.details,
			isError: data.isError ?? false,
			timestamp: row.createdAt
		} as AgentMessage
	}

	// Legacy types
	if (row.type === 'tool_call') {
		const tc = JSON.parse(row.payload) as {
			id: string
			name: string
			arguments: Record<string, unknown>
		}
		return {
			role: 'assistant',
			content: [
				{
					type: 'toolCall',
					id: tc.id,
					name: tc.name,
					arguments: tc.arguments
				}
			],
			provider: 'system',
			model: 'bootstrap-v1',
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			stopReason: 'toolUse',
			timestamp: row.createdAt
		} as AgentMessage
	}

	const msg = JSON.parse(row.payload) as AgentMessage
	// Skip empty assistant messages — these are artifacts
	// from multi-turn finalization that break tool_use ↔
	// tool_result pairing required by the Anthropic API.
	if (
		msg.role === 'assistant' &&
		Array.isArray(msg.content) &&
		msg.content.length === 0
	) {
		return null
	}
	return msg
}

/**
 * Reorder messages so each toolResult comes after its parent assistant message.
 *
 * During a TanStack multi-turn run, tool_execution_end events (→ tool_result)
 * are persisted before message_end (→ assistant_final) because tools execute
 * during the stream while the assistant message finalizes after. Loading by
 * seq gives [toolResult, assistant] — but the API expects [assistant, toolResult].
 */
/** Extract toolCall IDs from an assistant message's content blocks. */
function extractToolCallIds(msg: AgentMessage): string[] {
	const ids: string[] = []
	for (const block of msg.content) {
		if (block.type === 'toolCall') {
			ids.push(
				(block as { type: 'toolCall'; id: string }).id
			)
		}
	}
	return ids
}

function reorderToolResults(
	messages: AgentMessage[]
): AgentMessage[] {
	// Collect all toolCall IDs from assistant messages and their indices
	const toolCallToIdx = new Map<string, number>()
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]
		if (msg.role !== 'assistant') continue
		for (const id of extractToolCallIds(msg)) {
			toolCallToIdx.set(id, i)
		}
	}

	const result: AgentMessage[] = []
	const deferred: AgentMessage[] = []

	// Track which toolCallIds we've seen assistant messages for
	const seenToolCallIds = new Set<string>()

	for (const msg of messages) {
		if (msg.role === 'assistant') {
			result.push(msg)
			for (const id of extractToolCallIds(msg)) {
				seenToolCallIds.add(id)
			}
			// Flush any deferred tool results whose assistant is now seen
			flushDeferred(deferred, seenToolCallIds, result)
		} else if (msg.role === 'toolResult') {
			const toolCallId = (msg as { toolCallId: string })
				.toolCallId
			if (seenToolCallIds.has(toolCallId)) {
				result.push(msg)
			} else {
				deferred.push(msg)
			}
		} else {
			result.push(msg)
		}
	}

	// Append any remaining deferred (orphans — shouldn't happen normally)
	result.push(...deferred)

	return result
}

/** Move deferred tool results whose assistant has been seen into result. */
function flushDeferred(
	deferred: AgentMessage[],
	seenToolCallIds: Set<string>,
	result: AgentMessage[]
): void {
	const stillDeferred: AgentMessage[] = []
	for (const d of deferred) {
		const isReady =
			d.role === 'toolResult' &&
			seenToolCallIds.has(
				(d as { toolCallId: string }).toolCallId
			)
		if (isReady) {
			result.push(d)
		} else {
			stillDeferred.push(d)
		}
	}
	deferred.length = 0
	deferred.push(...stillDeferred)
}
