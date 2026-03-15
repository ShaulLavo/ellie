import { join } from 'path'
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
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
	threads,
	branches,
	events,
	threadChannels,
	agentBootstrapState,
	kv,
	type ThreadRow,
	type BranchRow,
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

export interface AppendInput<
	T extends EventType = EventType
> {
	branchId: string
	type: T
	payload: EventPayloadMap[T]
	runId?: string
	dedupeKey?: string
}

export interface QueryInput {
	branchId: string
	afterSeq?: number
	types?: EventType[]
	runId?: string
	limit?: number
}

const MIGRATIONS_DIR =
	process.env.ELLIE_DB_MIGRATIONS_DIR ??
	join(import.meta.dir, '..', 'drizzle')

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

	// -- Thread methods -------------------------------------------------------

	createThread(
		agentId: string,
		agentType: string,
		workspaceId: string,
		title?: string,
		dayKey?: string,
		id?: string
	): ThreadRow {
		const now = Date.now()
		const threadId = id ?? ulid()

		return this.db
			.insert(threads)
			.values({
				id: threadId,
				agentId,
				agentType,
				workspaceId,
				title: title ?? null,
				state: 'active',
				dayKey: dayKey ?? null,
				createdAt: now,
				updatedAt: now
			})
			.returning()
			.get()
	}

	getThread(id: string): ThreadRow | undefined {
		return this.db
			.select()
			.from(threads)
			.where(eq(threads.id, id))
			.get()
	}

	listThreads(filter?: {
		agentType?: string
		state?: string
	}): ThreadRow[] {
		const conditions = []
		if (filter?.agentType) {
			conditions.push(
				eq(threads.agentType, filter.agentType)
			)
		}
		if (filter?.state) {
			conditions.push(eq(threads.state, filter.state))
		}
		return this.db
			.select()
			.from(threads)
			.where(
				conditions.length > 0
					? and(...conditions)
					: undefined
			)
			.orderBy(asc(threads.createdAt))
			.all()
	}

	updateThread(
		id: string,
		patch: { title?: string; state?: string }
	): ThreadRow | undefined {
		const now = Date.now()
		return this.db
			.update(threads)
			.set({ ...patch, updatedAt: now })
			.where(eq(threads.id, id))
			.returning()
			.get()
	}

	// -- Branch methods -------------------------------------------------------

	createBranch(
		threadId: string,
		parentBranchId?: string,
		forkedFromEventId?: number,
		forkedFromSeq?: number,
		id?: string
	): BranchRow {
		const now = Date.now()
		const branchId = id ?? ulid()

		return this.db
			.insert(branches)
			.values({
				id: branchId,
				threadId,
				parentBranchId: parentBranchId ?? null,
				forkedFromEventId: forkedFromEventId ?? null,
				forkedFromSeq: forkedFromSeq ?? null,
				currentSeq: 0,
				createdAt: now,
				updatedAt: now
			})
			.returning()
			.get()
	}

	getBranch(id: string): BranchRow | undefined {
		return this.db
			.select()
			.from(branches)
			.where(eq(branches.id, id))
			.get()
	}

	listBranches(threadId: string): BranchRow[] {
		return this.db
			.select()
			.from(branches)
			.where(eq(branches.threadId, threadId))
			.orderBy(asc(branches.createdAt))
			.all()
	}

	deleteBranch(id: string): void {
		this.db
			.delete(branches)
			.where(eq(branches.id, id))
			.run()
	}

	/**
	 * Walk the parentBranchId chain to root, returning ordered branch IDs
	 * with their fork cutoff seqs.
	 */
	getBranchLineage(branchId: string): Array<{
		branchId: string
		forkedFromSeq: number | null
	}> {
		const lineage: Array<{
			branchId: string
			forkedFromSeq: number | null
		}> = []
		let currentId: string | null = branchId

		while (currentId) {
			const branch = this.getBranch(currentId)
			if (!branch) break
			lineage.unshift({
				branchId: branch.id,
				forkedFromSeq: branch.forkedFromSeq ?? null
			})
			currentId = branch.parentBranchId
		}

		return lineage
	}

	/**
	 * Load ancestor events up to fork points + current branch events.
	 * Single source of truth for full conversation history across forks.
	 */
	getLineageHistory(branchId: string): EventRow[] {
		const lineage = this.getBranchLineage(branchId)
		const allEvents: EventRow[] = []

		for (let i = 0; i < lineage.length; i++) {
			const segment = lineage[i]!
			const isLast = i === lineage.length - 1
			const nextForkSeq = isLast
				? undefined
				: (lineage[i + 1]?.forkedFromSeq ?? undefined)

			const conditions = [
				eq(events.branchId, segment.branchId)
			]

			if (nextForkSeq !== undefined) {
				conditions.push(lte(events.seq, nextForkSeq))
			}

			const rows = this.db
				.select()
				.from(events)
				.where(and(...conditions))
				.orderBy(asc(events.seq))
				.all()

			allEvents.push(...rows)
		}

		return allEvents
	}

	// -- Thread Channel methods -----------------------------------------------

	attachChannel(
		threadId: string,
		channelId: string,
		accountId: string,
		conversationKey: string
	): void {
		this.db
			.insert(threadChannels)
			.values({
				threadId,
				channelId,
				accountId,
				conversationKey,
				attachedAt: Date.now()
			})
			.run()
	}

	detachChannels(threadId: string): void {
		this.db
			.update(threadChannels)
			.set({ detachedAt: Date.now() })
			.where(
				and(
					eq(threadChannels.threadId, threadId),
					isNull(threadChannels.detachedAt)
				)
			)
			.run()
	}

	findActiveChannelThread(
		channelId: string,
		accountId: string,
		conversationKey: string
	): string | undefined {
		const row = this.db
			.select({ threadId: threadChannels.threadId })
			.from(threadChannels)
			.where(
				and(
					eq(threadChannels.channelId, channelId),
					eq(threadChannels.accountId, accountId),
					eq(
						threadChannels.conversationKey,
						conversationKey
					),
					isNull(threadChannels.detachedAt)
				)
			)
			.get()
		return row?.threadId
	}

	// -- Event methods --------------------------------------------------------

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

		// Run in a Drizzle transaction: load branch, bump seq, insert event
		const result = this.db.transaction(tx => {
			// Dedupe check
			if (input.dedupeKey) {
				const existing = tx
					.select()
					.from(events)
					.where(
						and(
							eq(events.branchId, input.branchId),
							eq(events.dedupeKey, input.dedupeKey)
						)
					)
					.get()
				if (existing) return existing
			}

			// Load and bump branch seq
			const branch = tx
				.select()
				.from(branches)
				.where(eq(branches.id, input.branchId))
				.get()
			if (!branch) {
				throw new Error(
					`Branch not found: ${input.branchId}`
				)
			}

			const nextSeq = branch.currentSeq + 1

			tx.update(branches)
				.set({ currentSeq: nextSeq, updatedAt: now })
				.where(eq(branches.id, input.branchId))
				.run()

			// Insert event and return the inserted row
			const inserted = tx
				.insert(events)
				.values({
					branchId: input.branchId,
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

	query(input: QueryInput): EventRow[] {
		const conditions = [eq(events.branchId, input.branchId)]

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

	getConversationHistory(branchId: string): AgentMessage[] {
		const rows = this.query({
			branchId,
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

	/**
	 * Load conversation history across the full branch lineage (ancestor chain).
	 * For forked branches, includes parent events up to fork points.
	 */
	getLineageConversationHistory(
		branchId: string
	): AgentMessage[] {
		const lineage = this.getBranchLineage(branchId)

		// Single branch (no forks) — fast path
		if (lineage.length <= 1) {
			return this.getConversationHistory(branchId)
		}

		const rows = this.getLineageHistory(branchId)
		const conversationTypes = new Set([
			'user_message',
			'assistant_message',
			'tool_execution'
		])
		const filtered = rows.filter(r =>
			conversationTypes.has(r.type)
		)

		const messages: AgentMessage[] = []
		for (const row of filtered) {
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

	/**
	 * Find runs that started but never closed within the given time window.
	 */
	findStaleRuns(
		maxAgeMs: number
	): Array<{ branchId: string; runId: string }> {
		const cutoff = Date.now() - maxAgeMs
		const e2 = alias(events, 'e2')

		const closedRuns = this.db
			.select({ id: sql`1` })
			.from(e2)
			.where(
				and(
					eq(e2.branchId, events.branchId),
					eq(e2.runId, events.runId),
					eq(e2.type, 'run_closed')
				)
			)

		const rows = this.db
			.selectDistinct({
				branchId: events.branchId,
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
			branchId: string
			runId: string
		}>
	}

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

	/**
	 * Find channel-originated runs that closed within the age window.
	 * Returns candidate runs — the caller determines which items
	 * remain undelivered by comparing against delivery checkpoints.
	 */
	findCandidateChannelRuns(maxAgeMs: number): Array<{
		branchId: string
		runId: string
		channelId: string
		accountId: string
		conversationId: string
	}> {
		const cutoff = Date.now() - maxAgeMs

		const rows = this.sqlite
			.query(
				`SELECT DISTINCT
					um.branch_id  AS branchId,
					um.run_id      AS runId,
					json_extract(um.payload, '$.source.channelId')      AS channelId,
					json_extract(um.payload, '$.source.accountId')      AS accountId,
					json_extract(um.payload, '$.source.conversationId') AS conversationId
				FROM events um
				INNER JOIN events rc
					ON rc.branch_id = um.branch_id
					AND rc.run_id    = um.run_id
					AND rc.type      = 'run_closed'
				WHERE um.type = 'user_message'
					AND um.run_id IS NOT NULL
					AND json_extract(um.payload, '$.source.channelId') IS NOT NULL
					AND um.created_at >= ?`
			)
			.all(cutoff) as Array<{
			branchId: string
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
		branchId: string,
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
				WHERE branch_id = ?
					AND run_id = ?
					AND type = 'channel_delivered'
					AND json_extract(payload, '$.channelId') = ?
					AND json_extract(payload, '$.accountId') = ?
					AND json_extract(payload, '$.conversationId') = ?
					AND json_extract(payload, '$.replyIndex') IS NOT NULL`
			)
			.all(
				branchId,
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
		branchId: string
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
					branch_id AS branchId,
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
			branchId: string
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
		branchId: string
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
						bootstrapInjectedBranchId: branchId,
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
						bootstrapInjectedBranchId: branchId,
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

	close(): void {
		this.sqlite.close()
	}
}
