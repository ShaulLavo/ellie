import type { AgentEvent } from '@ellie/agent'
import type {
	EventStore,
	EventRow,
	EventType,
	AgentMessage
} from '@ellie/db'

export type AgentRunEvent =
	| { type: 'event'; event: AgentEvent }
	| { type: 'closed' }

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

		// Clean up closed runs and run-level listeners for this session
		for (const key of this.#closedRuns) {
			if (key.startsWith(`${sessionId}:`)) {
				this.#closedRuns.delete(key)
			}
		}
		for (const channel of this.#listeners.keys()) {
			if (channel.startsWith(`run:${sessionId}:`)) {
				this.#listeners.delete(channel)
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

		// If this is a run_closed, also notify run-specific subscribers
		if (type === 'run_closed' && runId) {
			this.#closedRuns.add(this.#runKey(sessionId, runId))
			// Evict all entries when cache exceeds bound — DB fallback guarantees correctness
			if (this.#closedRuns.size > MAX_CLOSED_RUNS) {
				this.#closedRuns.clear()
			}
			this.#publish(this.#runChannel(sessionId, runId), {
				type: 'closed'
			} satisfies AgentRunEvent)
		}

		return row
	}

	// ── Agent run lifecycle ───────────────────────────────────────────────

	appendAgentRunEvent(
		sessionId: string,
		runId: string,
		event: AgentEvent
	): void {
		// Map agent events to persisted event types
		const mapping = this.#mapAgentEvent(event)
		if (mapping) {
			console.log(
				`[realtime-store] persisting event session=${sessionId} runId=${runId} agentType=${event.type} → dbType=${mapping.type}`
			)
			// Route through appendEvent so session-level subscribers (SSE) are notified
			this.appendEvent(
				sessionId,
				mapping.type,
				mapping.payload,
				runId
			)
		} else {
			console.log(
				`[realtime-store] skipping persistence for session=${sessionId} runId=${runId} type=${event.type} (no mapping)`
			)
		}

		// Always publish live to run subscribers (even for non-persisted events like deltas)
		this.#publish(this.#runChannel(sessionId, runId), {
			type: 'event',
			event
		} satisfies AgentRunEvent)
	}

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

	// ── Query wrappers ────────────────────────────────────────────────────

	listAgentMessages(sessionId: string): AgentMessage[] {
		return this.#store.getConversationHistory(sessionId)
	}

	queryEvents(
		sessionId: string,
		afterSeq?: number,
		types?: EventType[]
	) {
		return this.#store.query({ sessionId, afterSeq, types })
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

	subscribeToAgentRun(
		sessionId: string,
		runId: string,
		listener: Listener<AgentRunEvent>
	): () => void {
		return this.#subscribe(
			this.#runChannel(sessionId, runId),
			listener
		)
	}

	// ── Private ───────────────────────────────────────────────────────────

	#mapAgentEvent(event: AgentEvent): {
		type: EventType
		payload: Record<string, unknown>
	} | null {
		switch (event.type) {
			case 'agent_start':
				return { type: 'agent_start', payload: {} }
			case 'agent_end':
				return {
					type: 'agent_end',
					payload: { messages: event.messages }
				}
			case 'turn_start':
				return { type: 'turn_start', payload: {} }
			case 'turn_end':
				return {
					type: 'turn_end',
					payload: {}
				}
			case 'message_end': {
				// Persist the final message based on its role
				const msg = event.message
				if (msg.role === 'assistant') {
					const asst = msg as unknown as Record<
						string,
						unknown
					>
					const contentArr = Array.isArray(asst.content)
						? asst.content
						: []
					const textParts = (
						contentArr as Array<{
							type: string
							text?: string
						}>
					)
						.filter(c => c.type === 'text')
						.map(c => c.text ?? '')
					const textPreview = textParts
						.join('')
						.slice(0, 80)
					console.log(
						`[realtime-store] mapping message_end → assistant_final contentParts=${contentArr.length} stopReason=${asst.stopReason ?? 'unknown'} errorMessage=${asst.errorMessage ?? 'none'} text="${textPreview}"`
					)
					return {
						type: 'assistant_final',
						payload: asst
					}
				}
				return null
			}
			case 'tool_execution_end':
				return {
					type: 'tool_result',
					payload: {
						role: 'toolResult',
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						content: event.result.content,
						details: event.result.details,
						isError: event.isError,
						timestamp: Date.now()
					}
				}
			// Non-persisted events (message_start, message_update, tool_execution_start, etc.)
			default:
				return null
		}
	}

	#runKey(sessionId: string, runId: string): string {
		return `${sessionId}:${runId}`
	}

	#runChannel(sessionId: string, runId: string): string {
		return `run:${sessionId}:${runId}`
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
