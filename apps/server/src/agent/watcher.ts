/**
 * Watches sessions for new user messages and auto-routes them
 * to the agent. Decouples message persistence (chat route) from
 * agent invocation (AgentManager).
 *
 * Uses RealtimeStore's in-memory pub/sub — the same mechanism
 * that powers SSE — so there is zero latency and no polling.
 */

import type {
	RealtimeStore,
	SessionEvent
} from '../lib/realtime-store'
import type { AgentManager } from './manager'

export class AgentWatcher {
	private store: RealtimeStore
	private agentManager: AgentManager
	private unsubscribers = new Map<string, () => void>()

	constructor(
		store: RealtimeStore,
		agentManager: AgentManager
	) {
		this.store = store
		this.agentManager = agentManager
	}

	/**
	 * Start watching a session for new user messages.
	 * Idempotent — safe to call on every message POST.
	 */
	watch(sessionId: string): void {
		if (this.unsubscribers.has(sessionId)) return

		console.log(
			`[agent-watcher] watching session=${sessionId}`
		)
		const unsub = this.store.subscribeToSession(
			sessionId,
			(event: SessionEvent) => {
				if (event.type !== 'append') return

				const row = event.event
				if (row.type !== 'user_message') return

				// If the message already has a runId it was
				// persisted by AgentManager.prompt() — skip
				// to avoid double-prompting.
				if (row.runId) {
					console.log(
						`[agent-watcher] skipping user_message with runId=${row.runId} (already managed)`
					)
					return
				}

				console.log(
					`[agent-watcher] detected user_message seq=${row.seq} session=${sessionId}, triggering agent`
				)
				this.handleUserMessage(sessionId, row.payload)
			}
		)
		this.unsubscribers.set(sessionId, unsub)
	}

	/** Stop watching a session. */
	unwatch(sessionId: string): void {
		this.unsubscribers.get(sessionId)?.()
		this.unsubscribers.delete(sessionId)
	}

	/** Tear down all watchers. */
	dispose(): void {
		for (const unsub of this.unsubscribers.values()) {
			unsub()
		}
		this.unsubscribers.clear()
	}

	// ── Internal ──────────────────────────────────────────

	private handleUserMessage(
		sessionId: string,
		payload: string
	): void {
		let text: string
		try {
			const parsed = JSON.parse(payload) as {
				content?: Array<{ type: string; text?: string }>
			}
			text =
				parsed.content
					?.filter(c => c.type === 'text')
					.map(c => c.text ?? '')
					.join('') ?? ''
		} catch (err) {
			console.error(
				`[agent-watcher] failed to parse payload for session=${sessionId}:`,
				err instanceof Error ? err.message : String(err),
				`payload=${payload.slice(0, 200)}`
			)
			return
		}

		if (!text.trim()) {
			console.warn(
				`[agent-watcher] empty text after parse for session=${sessionId}, skipping`
			)
			return
		}

		console.log(
			`[agent-watcher] dispatching runAgent session=${sessionId} text=${text.slice(0, 100)}`
		)
		// Fire-and-forget — errors are logged, not propagated
		this.agentManager
			.runAgent(sessionId, text)
			.then(({ runId }) => {
				console.log(
					`[agent-watcher] runAgent started session=${sessionId} runId=${runId}`
				)
			})
			.catch(err => {
				console.error(
					`[agent-watcher] runAgent FAILED session=${sessionId}:`,
					err instanceof Error ? err.message : String(err)
				)
			})
	}
}
