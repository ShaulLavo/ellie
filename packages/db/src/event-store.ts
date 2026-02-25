import { join } from 'path'
import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as v from 'valibot'
import type { Database } from 'bun:sqlite'
import { openDatabase } from './init'
import { AuditLogger } from './audit-log'
import * as schema from './schema'
import { sessions, events, type SessionRow, type EventRow } from './schema'
import type { AgentMessage } from '@ellie/schemas'

export type { AgentMessage }

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
	'error'
] as const

export type EventType = (typeof EVENT_TYPES)[number]

const eventTypeSchema = v.picklist(EVENT_TYPES)

// ── Per-type payload schemas ────────────────────────────────────────────────

const textContent = v.object({ type: v.literal('text'), text: v.string() })
const imageContent = v.object({
	type: v.literal('image'),
	data: v.string(),
	mimeType: v.string()
})
const thinkingContent = v.object({
	type: v.literal('thinking'),
	thinking: v.string()
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
		content: v.array(v.variant('type', [textContent, imageContent])),
		timestamp: v.number()
	}),
	assistant_start: v.object({
		role: v.literal('assistant'),
		timestamp: v.number()
	}),
	assistant_final: v.object({
		role: v.literal('assistant'),
		content: v.array(v.variant('type', [textContent, thinkingContent, toolCallContent])),
		provider: v.string(),
		model: v.string(),
		usage: usageSchema,
		stopReason: v.picklist(['stop', 'length', 'toolUse', 'error', 'aborted']),
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
		content: v.array(v.variant('type', [textContent, imageContent])),
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
	})
}

// ── Input/output types ──────────────────────────────────────────────────────

export interface AppendInput {
	sessionId: string
	type: EventType
	payload: Record<string, unknown>
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

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'drizzle')

// ── EventStore ──────────────────────────────────────────────────────────────

export class EventStore {
	readonly db: ReturnType<typeof drizzle>
	readonly sqlite: Database
	readonly #audit: AuditLogger | null

	constructor(dbPath: string, auditLogDir?: string, migrationsFolder?: string) {
		this.sqlite = openDatabase(dbPath)
		this.db = drizzle(this.sqlite, { schema })

		// Run Drizzle migrations
		migrate(this.db, { migrationsFolder: migrationsFolder ?? MIGRATIONS_DIR })

		// Create partial unique index not representable in Drizzle
		this.sqlite.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_dedupe
        ON events(session_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL
    `)

		this.#audit = auditLogDir ? new AuditLogger(auditLogDir) : null
	}

	// ── Session CRUD ────────────────────────────────────────────────────────

	createSession(id?: string): SessionRow {
		const now = Date.now()
		const sessionId = id ?? crypto.randomUUID()

		if (id) {
			const existing = this.getSession(id)
			if (existing) throw new Error(`Session already exists: ${id}`)
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
		return this.db.select().from(sessions).where(eq(sessions.id, id)).get()
	}

	listSessions(): SessionRow[] {
		return this.db.select().from(sessions).orderBy(asc(sessions.createdAt)).all()
	}

	deleteSession(id: string): void {
		this.db.delete(sessions).where(eq(sessions.id, id)).run()
	}

	// ── Event append ────────────────────────────────────────────────────────

	append(input: AppendInput): EventRow {
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
					.where(and(eq(events.sessionId, input.sessionId), eq(events.dedupeKey, input.dedupeKey)))
					.get()
				if (existing) return existing
			}

			// Load and bump session seq
			const session = tx.select().from(sessions).where(eq(sessions.id, input.sessionId)).get()
			if (!session) {
				throw new Error(`Session not found: ${input.sessionId}`)
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

	// ── Event query ─────────────────────────────────────────────────────────

	query(input: QueryInput): EventRow[] {
		const conditions = [eq(events.sessionId, input.sessionId)]

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

	getConversationHistory(sessionId: string): AgentMessage[] {
		const rows = this.query({
			sessionId,
			types: ['user_message', 'assistant_final', 'tool_result']
		})

		const messages: AgentMessage[] = []
		for (const row of rows) {
			try {
				messages.push(JSON.parse(row.payload) as AgentMessage)
			} catch (err) {
				console.warn(`[EventStore] malformed payload in event ${row.id} (seq=${row.seq}):`, err)
			}
		}
		return messages
	}

	// ── Stale run recovery ────────────────────────────────────────────────

	/**
	 * Find runs that started but never closed within the given time window.
	 *
	 * Note: For large tables, consider adding a composite index:
	 *   CREATE INDEX idx_events_stale_runs ON events(type, run_id, created_at)
	 *     WHERE run_id IS NOT NULL;
	 */
	findStaleRuns(maxAgeMs: number): Array<{ sessionId: string; runId: string }> {
		const cutoff = Date.now() - maxAgeMs

		// Find runs that have an agent_start but no run_closed.
		// Raw SQL used for NOT EXISTS which Drizzle doesn't support.
		// Column mapping: events.sessionId → session_id, events.runId → run_id,
		//   events.type → type, events.createdAt → created_at (see schema.ts)
		const stale = this.sqlite
			.query<{ session_id: string; run_id: string }, [number]>(
				`
        SELECT DISTINCT e.session_id, e.run_id
        FROM events e
        WHERE e.run_id IS NOT NULL
          AND e.type = 'agent_start'
          AND e.created_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM events e2
            WHERE e2.session_id = e.session_id
              AND e2.run_id = e.run_id
              AND e2.type = 'run_closed'
          )
        `
			)
			.all(cutoff)

		return stale.map(r => ({
			sessionId: r.session_id,
			runId: r.run_id
		}))
	}

	// ── Cleanup ───────────────────────────────────────────────────────────

	close(): void {
		this.#audit?.close()
		this.sqlite.close()
	}
}
