/**
 * Agent controller — single persistent agent with session binding.
 *
 * Maintains a single Agent instance that is bound to the active session.
 * When a message arrives for a different session while idle, the agent
 * rebinds by loading that session's history and updating the prompt bundle.
 * When busy, cross-session messages are queued and processed FIFO after
 * the current run completes.
 *
 * Message routing within a bound session:
 *   - Agent idle  → prompt() starts a new run
 *   - Agent busy  → followUp() queues for automatic pickup by the agent loop
 *   - On agent_end with orphaned follow-ups → continue() re-enters the loop
 */

import {
	Agent,
	type AgentOptions,
	type AgentEvent,
	type AgentMessage
} from '@ellie/agent'
import type { EventType } from '@ellie/db'
import type { AnyTextAdapter } from '@tanstack/ai'
import { ulid } from '@ellie/utils'
import type {
	RealtimeStore,
	SessionEvent
} from '../lib/realtime-store'
import { buildSystemPrompt } from './system-prompt'

// ── Config ───────────────────────────────────────────────────────────────────

export interface AgentControllerOptions {
	/** TanStack AI adapter for LLM calls */
	adapter: AnyTextAdapter
	/** Workspace directory path for system prompt assembly */
	workspaceDir: string
	/** Additional AgentOptions passed to the Agent */
	agentOptions?: Partial<AgentOptions>
}

// ── Queued cross-session message ─────────────────────────────────────────────

interface QueuedMessage {
	sessionId: string
	text: string
}

// ── Controller ───────────────────────────────────────────────────────────────

export class AgentController {
	private agent: Agent
	private boundSessionId: string | null = null
	private store: RealtimeStore
	private options: AgentControllerOptions

	/** Global lock — serialises all routing decisions */
	private lock: Promise<void> = Promise.resolve()

	/** Cross-session message queue — processed FIFO when agent becomes idle */
	private crossSessionQueue: QueuedMessage[] = []

	/** Watcher subscriptions (pub/sub unsubscribe callbacks) */
	private unsubscribers = new Map<string, () => void>()

	constructor(
		store: RealtimeStore,
		options: AgentControllerOptions
	) {
		this.store = store
		this.options = options

		const systemPrompt = buildSystemPrompt(
			options.workspaceDir
		)

		this.agent = new Agent({
			...options.agentOptions,
			adapter: options.adapter,
			initialState: {
				...options.agentOptions?.initialState,
				systemPrompt
			},
			onEvent: event => this.handleEvent(event)
		})
	}

	// ── Lock ─────────────────────────────────────────────────────────────────

	private async withLock(
		fn: () => Promise<void>
	): Promise<void> {
		const prev = this.lock
		const next = prev.catch(() => {}).then(() => fn())
		this.lock = next
		try {
			await next
		} finally {
			if (this.lock === next) {
				this.lock = Promise.resolve()
			}
		}
	}

	// ── Session binding ─────────────────────────────────────────────────────

	/**
	 * Bind the agent to a session by loading its history and
	 * updating the system prompt.
	 */
	private bindToSession(sessionId: string): void {
		this.store.ensureSession(sessionId)

		const systemPrompt = buildSystemPrompt(
			this.options.workspaceDir
		)
		const history = this.loadHistory(sessionId)

		console.log(
			`[agent-controller] binding to session=${sessionId} history=${history.length} messages`
		)

		this.agent.state.systemPrompt = systemPrompt
		this.agent.replaceMessages(history)
		this.boundSessionId = sessionId
	}

	// ── Message routing (core) ───────────────────────────────────────────────

	/**
	 * Route a user message to the agent.
	 *
	 * Same-session routing:
	 *   - Agent idle → prompt()
	 *   - Agent busy → followUp()
	 *
	 * Cross-session routing:
	 *   - Agent idle → rebind + prompt()
	 *   - Agent busy → queue for later processing
	 */
	async handleMessage(
		sessionId: string,
		text: string
	): Promise<{
		runId: string
		routed: 'prompt' | 'followUp' | 'queued'
	}> {
		this.store.ensureSession(sessionId)

		const runId = ulid()
		let routed: 'prompt' | 'followUp' | 'queued' = 'prompt'

		await this.withLock(async () => {
			if (this.agent.state.isStreaming) {
				if (this.boundSessionId === sessionId) {
					// Same session, agent busy — queue as follow-up
					console.log(
						`[agent-controller] agent busy session=${sessionId}, queuing as followUp`
					)
					this.agent.followUp({
						role: 'user',
						content: [{ type: 'text', text }],
						timestamp: Date.now()
					})
					routed = 'followUp'
				} else {
					// Different session, agent busy — queue for later
					console.log(
						`[agent-controller] agent busy on session=${this.boundSessionId}, queuing cross-session message for session=${sessionId}`
					)
					this.crossSessionQueue.push({
						sessionId,
						text
					})
					routed = 'queued'
				}
				return
			}

			// Agent idle — bind if needed and start new run
			if (this.boundSessionId !== sessionId) {
				this.bindToSession(sessionId)
			} else if (this.agent.state.messages.length === 0) {
				// First message on this binding — load history
				const history = this.loadHistory(sessionId)
				if (history.length > 0) {
					this.agent.replaceMessages(history)
				}
			}

			console.log(
				`[agent-controller] agent idle session=${sessionId}, starting prompt runId=${runId}`
			)
			this.agent.runId = runId

			// Start the prompt (non-blocking — events flow via onEvent)
			this.agent.prompt(text).catch(err => {
				console.error(
					`[agent-controller] prompt FAILED session=${sessionId} runId=${runId}:`,
					err instanceof Error ? err.message : String(err)
				)
				this.writeErrorEvent(sessionId, runId)
			})
		})

		return { runId, routed }
	}

	// ── Watcher role ─────────────────────────────────────────────────────────

	/**
	 * Start watching a session for new user messages.
	 * Idempotent — safe to call on every message POST.
	 *
	 * Uses RealtimeStore's in-memory pub/sub (zero latency, no polling).
	 */
	watch(sessionId: string): void {
		if (this.unsubscribers.has(sessionId)) return

		console.log(
			`[agent-controller] watching session=${sessionId}`
		)
		const unsub = this.store.subscribeToSession(
			sessionId,
			(event: SessionEvent) => {
				if (event.type !== 'append') return

				const row = event.event
				if (row.type !== 'user_message') return

				// If the message already has a runId it was
				// persisted externally — skip to avoid double-prompting
				if (row.runId) return

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

	// ── Control passthrough ──────────────────────────────────────────────────

	/**
	 * Queue a steering message for the running agent.
	 */
	steer(sessionId: string, text: string): void {
		if (this.boundSessionId !== sessionId) {
			throw new Error(
				`Agent not bound to session ${sessionId}`
			)
		}

		this.agent.steer({
			role: 'user',
			content: [{ type: 'text', text }],
			timestamp: Date.now()
		})
	}

	/**
	 * Abort the running agent prompt.
	 */
	abort(sessionId: string): void {
		if (this.boundSessionId !== sessionId) {
			throw new Error(
				`Agent not bound to session ${sessionId}`
			)
		}
		this.agent.abort()
	}

	// ── Queries ──────────────────────────────────────────────────────────────

	/**
	 * Load conversation history from persisted events.
	 *
	 * The DB store returns `AgentMessage` from `@ellie/schemas` (where
	 * `provider` is `string`), but the Agent runtime expects `@ellie/agent`'s
	 * `AgentMessage` (where `provider` is `ProviderName`).  The data is
	 * structurally compatible — the DB just stores wider types — so a cast
	 * at this boundary is safe.
	 */
	loadHistory(sessionId: string): AgentMessage[] {
		return this.store.listAgentMessages(
			sessionId
		) as AgentMessage[]
	}

	/**
	 * Check if a session exists.
	 */
	hasSession(sessionId: string): boolean {
		return this.store.hasSession(sessionId)
	}

	// ── Internal: watcher message parsing ────────────────────────────────────

	private handleUserMessage(
		sessionId: string,
		payload: string
	): void {
		let text: string
		try {
			const parsed = JSON.parse(payload) as {
				content?: Array<{
					type: string
					text?: string
				}>
			}
			text =
				parsed.content
					?.filter(c => c.type === 'text')
					.map(c => c.text ?? '')
					.join('') ?? ''
		} catch (err) {
			console.error(
				`[agent-controller] failed to parse payload for session=${sessionId}:`,
				err instanceof Error ? err.message : String(err),
				`payload=${payload.slice(0, 200)}`
			)
			return
		}

		if (!text.trim()) {
			console.warn(
				`[agent-controller] empty text after parse for session=${sessionId}, skipping`
			)
			return
		}

		console.log(
			`[agent-controller] dispatching handleMessage session=${sessionId} text=${text.slice(0, 100)}`
		)
		this.handleMessage(sessionId, text)
			.then(({ runId, routed }) => {
				console.log(
					`[agent-controller] handleMessage completed session=${sessionId} runId=${runId} routed=${routed}`
				)
			})
			.catch(err => {
				console.error(
					`[agent-controller] handleMessage FAILED session=${sessionId}:`,
					err instanceof Error ? err.message : String(err)
				)
			})
	}

	// ── Internal: event persistence ──────────────────────────────────────────

	private handleEvent(event: AgentEvent): void {
		const sessionId = this.boundSessionId
		if (!sessionId) {
			console.warn(
				`[agent-controller] event received without bound session type=${event.type} — not persisted`
			)
			return
		}

		const runId = this.agent.runId

		const eventSummary = this.summarizeEvent(event)
		console.log(
			`[agent-controller] event session=${sessionId} runId=${runId ?? 'none'} ${eventSummary}`
		)

		if (!runId) {
			console.warn(
				`[agent-controller] event received without runId session=${sessionId} type=${event.type} — not persisted`
			)
			return
		}

		// Map every AgentEvent to one or more DB rows and persist
		const rows = this.mapEventToDb(event)
		for (const row of rows) {
			try {
				this.store.appendEvent(
					sessionId,
					row.type,
					row.payload,
					runId
				)
			} catch (err) {
				console.error(
					`[agent-controller] failed to persist event session=${sessionId} runId=${runId} dbType=${row.type}:`,
					err instanceof Error ? err.message : String(err)
				)
			}
		}

		// On agent_end, close the run and process queues
		if (event.type === 'agent_end') {
			console.log(
				`[agent-controller] closing run session=${sessionId} runId=${runId}`
			)
			try {
				this.store.closeAgentRun(sessionId, runId)
			} catch {
				// Already closed — non-fatal
			}
			this.agent.runId = undefined

			// Check for orphaned follow-ups first (same session)
			if (this.agent.hasQueuedMessages()) {
				console.log(
					`[agent-controller] agent_end with queued messages session=${sessionId}, scheduling continue()`
				)
				queueMicrotask(() => {
					this.withLock(async () => {
						if (
							!this.agent.state.isStreaming &&
							this.agent.hasQueuedMessages()
						) {
							const newRunId = ulid()
							this.agent.runId = newRunId
							console.log(
								`[agent-controller] continuing with queued messages session=${sessionId} runId=${newRunId}`
							)
							this.agent.continue().catch(err => {
								console.error(
									`[agent-controller] continue FAILED session=${sessionId} runId=${newRunId}:`,
									err instanceof Error
										? err.message
										: String(err)
								)
								this.writeErrorEvent(sessionId, newRunId)
							})
						}
					})
				})
			} else if (this.crossSessionQueue.length > 0) {
				// Process cross-session queue FIFO
				queueMicrotask(() => {
					this.processCrossSessionQueue()
				})
			}
		}
	}

	// ── Internal: cross-session queue processing ─────────────────────────────

	private processCrossSessionQueue(): void {
		const next = this.crossSessionQueue.shift()
		if (!next) return

		console.log(
			`[agent-controller] processing cross-session queue: session=${next.sessionId}`
		)
		this.handleMessage(next.sessionId, next.text).catch(
			err => {
				console.error(
					`[agent-controller] cross-session handleMessage FAILED session=${next.sessionId}:`,
					err instanceof Error ? err.message : String(err)
				)
			}
		)
	}

	// ── Internal: error events ───────────────────────────────────────────────

	private writeErrorEvent(
		sessionId: string,
		runId: string
	): void {
		console.error(
			`[agent-controller] writing error event session=${sessionId} runId=${runId}`
		)
		try {
			this.store.appendEvent(
				sessionId,
				'error',
				{
					message: 'Agent prompt failed unexpectedly'
				},
				runId
			)
			this.store.closeAgentRun(sessionId, runId)
		} catch (err) {
			console.error(
				`[agent-controller] writeErrorEvent failed session=${sessionId} runId=${runId}:`,
				err instanceof Error ? err.message : String(err)
			)
		}
	}

	// ── Internal: event → DB mapping ─────────────────────────────────────────

	/**
	 * Map an AgentEvent to one or more DB event rows.
	 *
	 * Most events map 1:1. Two exceptions produce dual writes for
	 * backward compatibility with getConversationHistory():
	 *   message_end (assistant) → message_end + assistant_final
	 *   tool_execution_end      → tool_execution_end + tool_result
	 */
	private mapEventToDb(event: AgentEvent): Array<{
		type: EventType
		payload: Record<string, unknown>
	}> {
		switch (event.type) {
			case 'agent_start':
				return [{ type: 'agent_start', payload: {} }]
			case 'agent_end':
				return [
					{
						type: 'agent_end',
						payload: {
							messages: event.messages
						}
					}
				]
			case 'turn_start':
				return [{ type: 'turn_start', payload: {} }]
			case 'turn_end':
				return [{ type: 'turn_end', payload: {} }]

			case 'message_start':
				return [
					{
						type: 'message_start',
						payload: {
							message: event.message
						}
					}
				]

			case 'message_update':
				// Store only the delta, not the accumulated partial
				return [
					{
						type: 'message_update',
						payload: {
							streamEvent: event.streamEvent
						}
					}
				]

			case 'message_end': {
				const msg = event.message
				const rows: Array<{
					type: EventType
					payload: Record<string, unknown>
				}> = [
					{
						type: 'message_end',
						payload: { message: msg }
					}
				]

				// Dual-write: also persist as assistant_final for backward compat
				if (msg.role === 'assistant') {
					rows.push({
						type: 'assistant_final',
						payload: msg as unknown as Record<
							string,
							unknown
						>
					})
				}

				return rows
			}

			case 'tool_execution_start':
				return [
					{
						type: 'tool_execution_start',
						payload: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args
						}
					}
				]

			case 'tool_execution_update':
				return [
					{
						type: 'tool_execution_update',
						payload: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult
						}
					}
				]

			case 'tool_execution_end': {
				return [
					{
						type: 'tool_execution_end',
						payload: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							result: event.result,
							isError: event.isError
						}
					},
					// Dual-write: also persist as tool_result for backward compat
					{
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
				]
			}

			default:
				return []
		}
	}

	private summarizeEvent(event: AgentEvent): string {
		switch (event.type) {
			case 'message_end': {
				const msg = event.message
				const role = msg.role
				if (role === 'assistant') {
					const asst = msg as unknown as Record<
						string,
						unknown
					>
					const contentLen = Array.isArray(asst.content)
						? asst.content.length
						: 0
					const textParts = Array.isArray(asst.content)
						? (
								asst.content as Array<{
									type: string
									text?: string
								}>
							)
								.filter(c => c.type === 'text')
								.map(c => c.text ?? '')
						: []
					const textPreview = textParts
						.join('')
						.slice(0, 80)
					return `type=message_end role=assistant contentParts=${contentLen} stopReason=${asst.stopReason ?? 'unknown'} errorMessage=${asst.errorMessage ?? 'none'} text="${textPreview}"`
				}
				return `type=message_end role=${role}`
			}
			case 'agent_end':
				return `type=agent_end messages=${event.messages?.length ?? 0}`
			case 'message_start':
				return `type=message_start role=${event.message.role}`
			case 'message_update':
				return `type=message_update role=${event.message.role}`
			case 'turn_start':
				return `type=turn_start`
			case 'turn_end':
				return `type=turn_end role=${event.message.role}`
			default:
				return `type=${event.type}`
		}
	}
}
