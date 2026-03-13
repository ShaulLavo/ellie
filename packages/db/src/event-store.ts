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
import {
	eventTypeSchema,
	payloadSchemas
} from './event-schemas'
import {
	parseEventRow,
	reorderToolResults
} from './history'
import { SpeechArtifactStore } from './speech-store'

export type { AgentMessage, EventType }

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
	readonly speechArtifacts: SpeechArtifactStore

	constructor(dbPath: string, migrationsFolder?: string) {
		this.sqlite = openDatabase(dbPath)
		this.db = drizzle(this.sqlite, { schema })

		// Run Drizzle migrations
		migrate(this.db, {
			migrationsFolder: migrationsFolder ?? MIGRATIONS_DIR
		})

		this.speechArtifacts = new SpeechArtifactStore(this.db)
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

	/**
	 * Update the runId of an existing event row.
	 * Used to backfill the runId on a user_message that was persisted
	 * before routing determined which run it belongs to.
	 */
	updateRunId(id: number, runId: string): EventRow {
		const result = this.db
			.update(events)
			.set({ runId })
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
				'assistant_message',
				'tool_execution'
			]
		})

		const messages: AgentMessage[] = []
		for (const row of rows) {
			try {
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
		return rows as Array<{
			sessionId: string
			runId: string
		}>
	}

	// ── Stale event recovery ─────────────────────────────────────────────

	/**
	 * Mark any in-flight tool_execution (status='running') as 'error'
	 * and any in-flight assistant_message (streaming=true) as finalized.
	 * Called at startup to clean up after a crash.
	 */
	recoverStaleStreamingEvents(): {
		tools: number
		messages: number
	} {
		const toolResult = this.sqlite.run(
			`UPDATE events
			 SET payload = json_set(
				json_set(payload, '$.status', 'error'),
				'$.isError', json('true')
			 )
			 WHERE type = 'tool_execution'
			   AND json_extract(payload, '$.status') = 'running'`
		)

		const msgResult = this.sqlite.run(
			`UPDATE events
			 SET payload = json_set(payload, '$.streaming', json('false'))
			 WHERE type = 'assistant_message'
			   AND json_extract(payload, '$.streaming') = json('true')`
		)

		return {
			tools: toolResult.changes,
			messages: msgResult.changes
		}
	}

	// ── Channel run recovery ─────────────────────────────────────────────

	/**
	 * Find channel-originated runs that closed within the age window.
	 * Returns candidate runs — the caller determines which items
	 * remain undelivered by comparing against delivery checkpoints.
	 */
	findCandidateChannelRuns(maxAgeMs: number): Array<{
		sessionId: string
		runId: string
		channelId: string
		accountId: string
		conversationId: string
	}> {
		const cutoff = Date.now() - maxAgeMs

		const rows = this.sqlite
			.query(
				`SELECT DISTINCT
					um.session_id  AS sessionId,
					um.run_id      AS runId,
					json_extract(um.payload, '$.source.channelId')      AS channelId,
					json_extract(um.payload, '$.source.accountId')      AS accountId,
					json_extract(um.payload, '$.source.conversationId') AS conversationId
				FROM events um
				INNER JOIN events rc
					ON rc.session_id = um.session_id
					AND rc.run_id    = um.run_id
					AND rc.type      = 'run_closed'
				WHERE um.type = 'user_message'
					AND um.run_id IS NOT NULL
					AND json_extract(um.payload, '$.source.channelId') IS NOT NULL
					AND um.created_at >= ?`
			)
			.all(cutoff) as Array<{
			sessionId: string
			runId: string
			channelId: string
			accountId: string
			conversationId: string
		}>
		return rows
	}

	/**
	 * Load all delivery checkpoints for a given run + target.
	 * Returns the per-item checkpoint data used to compute which
	 * outbound items have already been sent.
	 */
	findDeliveryCheckpoints(
		sessionId: string,
		runId: string,
		channelId: string,
		accountId: string,
		conversationId: string
	): Array<{
		replyIndex: number
		payloadIndex: number
		attachmentIndex: number
		kind: string
	}> {
		const rows = this.sqlite
			.query(
				`SELECT
					json_extract(payload, '$.replyIndex')      AS replyIndex,
					json_extract(payload, '$.payloadIndex')    AS payloadIndex,
					json_extract(payload, '$.attachmentIndex') AS attachmentIndex,
					json_extract(payload, '$.kind')            AS kind
				FROM events
				WHERE session_id = ?
					AND run_id = ?
					AND type = 'channel_delivered'
					AND json_extract(payload, '$.channelId') = ?
					AND json_extract(payload, '$.accountId') = ?
					AND json_extract(payload, '$.conversationId') = ?
					AND json_extract(payload, '$.replyIndex') IS NOT NULL`
			)
			.all(
				sessionId,
				runId,
				channelId,
				accountId,
				conversationId
			) as Array<{
			replyIndex: number
			payloadIndex: number
			attachmentIndex: number
			kind: string
		}>
		return rows
	}

	/**
	 * Find persisted live_delivery events with status 'streaming' within the age window.
	 * Used on crash recovery to fail partial live messages.
	 */
	findStreamingLiveDeliveries(maxAgeMs: number): Array<{
		sessionId: string
		runId: string
		channelId: string
		accountId: string
		conversationId: string
		assistantRowId: number
		handle: Record<string, unknown>
		lastSentText: string
	}> {
		const cutoff = Date.now() - maxAgeMs
		const rows = this.sqlite
			.query(
				`SELECT
					session_id AS sessionId,
					run_id AS runId,
					json_extract(payload, '$.channelId') AS channelId,
					json_extract(payload, '$.accountId') AS accountId,
					json_extract(payload, '$.conversationId') AS conversationId,
					json_extract(payload, '$.assistantRowId') AS assistantRowId,
					json_extract(payload, '$.handle') AS handle,
					json_extract(payload, '$.lastSentText') AS lastSentText
				FROM events
				WHERE type = 'live_delivery'
					AND json_extract(payload, '$.status') = 'streaming'
					AND json_extract(payload, '$.updatedAt') > ?
				ORDER BY id ASC`
			)
			.all(cutoff) as Array<{
			sessionId: string
			runId: string
			channelId: string
			accountId: string
			conversationId: string
			assistantRowId: number
			handle: string
			lastSentText: string
		}>
		return rows.map(r => ({
			...r,
			handle:
				typeof r.handle === 'string'
					? JSON.parse(r.handle)
					: (r.handle as Record<string, unknown>)
		}))
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
		this.sqlite.close()
	}
}
