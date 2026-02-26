import type {
	EventStore,
	EventRow,
	EventType,
	AgentMessage
} from '@ellie/db'

export type SessionEvent = {
	type: 'append'
	event: EventRow
}

type Listener<T> = (event: T) => void

const MAX_CLOSED_RUNS = 10_000

export class RealtimeStore {
	readonly #store: EventStore
	readonly #listeners = new Map<
		string,
		Set<Listener<unknown>>
	>()
	readonly #closedRuns = new Set<string>()

	constructor(store: EventStore) {
		this.#store = store
	}

	get eventStore(): EventStore {
		return this.#store
	}

	// ── Session CRUD ──────────────────────────────────────────────────────

	ensureSession(sessionId: string): void {
		try {
			if (!this.#store.getSession(sessionId)) {
				this.#store.createSession(sessionId)
			}
		} catch {
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

	// ── Event append (with live notification) ─────────────────────────────

	appendEvent(
		sessionId: string,
		type: EventType,
		payload: Record<string, unknown>,
		runId?: string,
		dedupeKey?: string
	): EventRow {
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

	// ── Agent run lifecycle ───────────────────────────────────────────────

	closeAgentRun(sessionId: string, runId: string): void {
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
