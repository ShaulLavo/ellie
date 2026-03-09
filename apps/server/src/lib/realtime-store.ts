import type {
	EventStore,
	EventRow,
	EventType,
	EventPayloadMap,
	AgentMessage,
	SessionRow
} from '@ellie/db'
import { isDurableEventType } from '@ellie/db'

export type SessionEvent =
	| { type: 'append'; event: EventRow }
	| { type: 'update'; event: EventRow }

type Listener<T> = (event: T) => void

const MAX_CLOSED_RUNS = 10_000

export type RotationEvent = {
	type: 'rotated'
	previousSessionId: string
	newSessionId: string
}

export interface TraceEntry {
	sessionId: string
	/** Free-form type, e.g. 'memory.recall_start', 'controller.prompt_failed' */
	type: string
	runId?: string
	payload: unknown
}

export class RealtimeStore {
	readonly #store: EventStore
	readonly #listeners = new Map<
		string,
		Set<Listener<unknown>>
	>()
	readonly #closedRuns = new Set<string>()
	#currentSessionId: string

	constructor(store: EventStore, initialSessionId: string) {
		this.#store = store
		this.#currentSessionId = initialSessionId
		this.ensureSession(initialSessionId)
		store.setKv('currentSessionId', initialSessionId)
	}

	// ── Current session ───────────────────────────────────────────────

	getCurrentSessionId(): string {
		return this.#currentSessionId
	}

	rotateSession(newSessionId: string): void {
		const previous = this.#currentSessionId
		if (previous === newSessionId) return

		this.ensureSession(newSessionId)
		this.#currentSessionId = newSessionId
		this.#store.setKv('currentSessionId', newSessionId)

		// Persist a session_rotated event in the new session
		// Use dedupeKey to prevent duplicates (e.g. from hot-reload recreating Cron)
		this.appendEvent(
			newSessionId,
			'session_rotated',
			{
				previousSessionId: previous,
				message: 'New day, new session'
			},
			undefined,
			`session_rotated:${newSessionId}`
		)

		this.#publish<RotationEvent>('current-session', {
			type: 'rotated',
			previousSessionId: previous,
			newSessionId
		})
	}

	subscribeToRotation(
		listener: Listener<RotationEvent>
	): () => void {
		return this.#subscribe('current-session', listener)
	}

	getSession(sessionId: string): SessionRow | undefined {
		return this.#store.getSession(sessionId)
	}

	// ── Session CRUD ──────────────────────────────────────────────────────

	ensureSession(sessionId: string): void {
		try {
			if (!this.#store.getSession(sessionId)) {
				this.#store.createSession(sessionId)
			}
		} catch (err) {
			const isConstraintViolation =
				err instanceof Error &&
				err.message.includes('UNIQUE constraint')
			if (!isConstraintViolation) {
				console.warn(
					`[RealtimeStore] Unexpected error creating session ${sessionId}:`,
					err
				)
			}
			// Session may have been created concurrently — verify it exists
			if (!this.#store.getSession(sessionId))
				throw new Error(
					`Failed to ensure session: ${sessionId}`
				)
		}
	}

	hasSession(sessionId: string): boolean {
		return this.#store.getSession(sessionId) !== undefined
	}

	deleteSession(sessionId: string): void {
		// Delete from persistent store (cascades to events)
		this.#store.deleteSession(sessionId)

		// Clean up in-memory session listeners
		this.#listeners.delete(`session:${sessionId}`)

		// Clean up closed-run cache for this session
		for (const key of this.#closedRuns) {
			if (key.startsWith(`${sessionId}:`)) {
				this.#closedRuns.delete(key)
			}
		}
	}

	// ── Ephemeral publish (SSE only, no DB write) ────────────────────────

	/**
	 * Broadcast an event to SSE subscribers without persisting to the DB.
	 * Used for high-frequency streaming deltas (message_update) that are
	 * redundant once the final message_end is persisted.
	 */
	publishEphemeral<T extends EventType>(
		sessionId: string,
		type: T,
		payload: EventPayloadMap[T],
		runId?: string
	): void {
		this.#publish(`session:${sessionId}`, {
			type: 'append',
			event: {
				id: -1, // ephemeral — not in DB
				sessionId,
				seq: -1,
				runId: runId ?? null,
				type,
				payload: JSON.stringify(payload),
				dedupeKey: null,
				createdAt: Date.now()
			}
		} satisfies SessionEvent)
	}

	// ── Ephemeral trace (SSE only, no disk) ──────────────────────────────

	/**
	 * Broadcast a structured trace entry as ephemeral SSE only.
	 * No disk write — canonical trace persistence is handled by TraceRecorder.
	 */
	publishTraceEphemeral(entry: TraceEntry): void {
		this.#publish(`session:${entry.sessionId}`, {
			type: 'append',
			event: {
				id: -1,
				sessionId: entry.sessionId,
				seq: -1,
				runId: entry.runId ?? null,
				type: entry.type,
				payload: JSON.stringify(entry.payload),
				dedupeKey: null,
				createdAt: Date.now()
			}
		} satisfies SessionEvent)
	}

	// ── Event append (with live notification) ─────────────────────────────

	appendEvent<T extends EventType>(
		sessionId: string,
		type: T,
		payload: EventPayloadMap[T],
		runId?: string,
		dedupeKey?: string
	): EventRow {
		if (!isDurableEventType(type)) {
			return {
				id: -1,
				sessionId,
				seq: -1,
				runId: runId ?? null,
				type,
				payload: JSON.stringify(payload),
				dedupeKey: dedupeKey ?? null,
				createdAt: Date.now()
			}
		}

		const row = this.#store.append({
			sessionId,
			type,
			payload,
			runId,
			dedupeKey
		})

		// Notify session-level subscribers
		this.#publish(`session:${sessionId}`, {
			type: 'append',
			event: row
		} satisfies SessionEvent)

		// Track run closure in memory cache
		if (type === 'run_closed' && runId) {
			this.#closedRuns.add(this.#runKey(sessionId, runId))
			if (this.#closedRuns.size > MAX_CLOSED_RUNS) {
				this.#closedRuns.clear()
			}
		}

		return row
	}

	// ── Event update (in-place, with live notification) ─────────────────

	/**
	 * Update an existing event row's payload in place and notify subscribers.
	 * Used for streaming: the row is INSERT'd via appendEvent, then UPDATE'd
	 * for every delta and at completion.
	 */
	updateEvent(
		id: number,
		payload: unknown,
		sessionId: string
	): EventRow {
		const row = this.#store.update(id, payload)

		this.#publish(`session:${sessionId}`, {
			type: 'update',
			event: row
		} satisfies SessionEvent)

		return row
	}

	/**
	 * Update the runId of an existing event and notify subscribers.
	 * Used to backfill runId on user_message events after routing.
	 */
	updateEventRunId(
		id: number,
		runId: string,
		sessionId: string
	): EventRow {
		const row = this.#store.updateRunId(id, runId)

		this.#publish(`session:${sessionId}`, {
			type: 'update',
			event: row
		} satisfies SessionEvent)

		return row
	}

	// ── Agent run lifecycle ───────────────────────────────────────────────

	closeAgentRun(sessionId: string, runId: string): void {
		if (this.isAgentRunClosed(sessionId, runId)) return
		this.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)
	}

	isAgentRunClosed(
		sessionId: string,
		runId: string
	): boolean {
		// Check in-memory cache first, then fall back to DB for runs closed before this process started
		if (
			this.#closedRuns.has(this.#runKey(sessionId, runId))
		)
			return true

		const closedEvents = this.#store.query({
			sessionId,
			runId,
			types: ['run_closed'],
			limit: 1
		})
		if (closedEvents.length > 0) {
			this.#closedRuns.add(this.#runKey(sessionId, runId))
			return true
		}
		return false
	}

	// ── Session management ───────────────────────────────────────────────

	createSession(id?: string) {
		return this.#store.createSession(id)
	}

	listSessions() {
		return this.#store.listSessions()
	}

	// ── Query wrappers ────────────────────────────────────────────────────

	listAgentMessages(sessionId: string): AgentMessage[] {
		return this.#store.getConversationHistory(sessionId)
	}

	queryEvents(
		sessionId: string,
		afterSeq?: number,
		types?: EventType[],
		limit?: number
	) {
		return this.#store.query({
			sessionId,
			afterSeq,
			types,
			limit
		})
	}

	queryRunEvents(sessionId: string, runId: string) {
		return this.#store.query({ sessionId, runId })
	}

	// ── Subscriptions ─────────────────────────────────────────────────────

	subscribeToSession(
		sessionId: string,
		listener: Listener<SessionEvent>
	): () => void {
		return this.#subscribe(`session:${sessionId}`, listener)
	}

	// ── Private ───────────────────────────────────────────────────────────

	#runKey(sessionId: string, runId: string): string {
		return `${sessionId}:${runId}`
	}

	#publish<T>(channel: string, event: T): void {
		const listeners = this.#listeners.get(channel)
		if (!listeners) return
		for (const listener of listeners) {
			;(listener as Listener<T>)(event)
		}
	}

	#subscribe<T>(
		channel: string,
		listener: Listener<T>
	): () => void {
		let listeners = this.#listeners.get(channel)
		if (!listeners) {
			listeners = new Set<Listener<unknown>>()
			this.#listeners.set(channel, listeners)
		}

		listeners.add(listener as Listener<unknown>)

		return () => {
			const existing = this.#listeners.get(channel)
			if (!existing) return
			existing.delete(listener as Listener<unknown>)
			if (existing.size !== 0) return
			this.#listeners.delete(channel)
		}
	}
}
