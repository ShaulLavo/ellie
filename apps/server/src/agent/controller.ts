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
 *
 * Tool surface (exec-mode architecture):
 *   - basicDirectTools: shell, search, workspace read/write
 *   - script_exec: ephemeral one-shot TypeScript execution
 *   - session_exec: persistent REPL session execution
 */

import {
	Agent,
	type AgentOptions,
	type AgentEvent,
	type AgentMessage
} from '@ellie/agent'
import type { EventType, EventPayloadMap } from '@ellie/db'
import type { TypedEvent } from '@ellie/schemas/events'
import type { AnyTextAdapter } from '@tanstack/ai'
import { ulid } from 'fast-ulid'
import type {
	RealtimeStore,
	SessionEvent
} from '../lib/realtime-store'
import { buildSystemPrompt } from './system-prompt'
import type { MemoryOrchestrator } from './memory-orchestrator'
import { createToolRegistry } from './tools/capability-registry'
import { createMemoryAppendDailyTool } from './tools/memory-daily'

// ── Config ───────────────────────────────────────────────────────────────────

export interface AgentControllerOptions {
	/** TanStack AI adapter for LLM calls */
	adapter: AnyTextAdapter
	/** Workspace directory path for system prompt assembly */
	workspaceDir: string
	/** Data directory for session artifacts and snapshots */
	dataDir: string
	/** Additional AgentOptions passed to the Agent */
	agentOptions?: Partial<AgentOptions>
	/** Memory orchestrator for recall/retain integration */
	memory?: MemoryOrchestrator
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
	private memory: MemoryOrchestrator | null
	private baseSystemPrompt: string
	/** Set of runIds that are enforcement turns (skip re-enforcement) */
	private enforcementRunIds = new Set<string>()

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
		this.memory = options.memory ?? null

		const systemPrompt = buildSystemPrompt(
			options.workspaceDir
		)
		this.baseSystemPrompt = systemPrompt
		const registry = createToolRegistry({
			workspaceDir: options.workspaceDir,
			dataDir: options.dataDir,
			getSessionId: () => this.boundSessionId
		})
		const memoryTool = createMemoryAppendDailyTool(
			options.workspaceDir
		)

		this.agent = new Agent({
			...options.agentOptions,
			adapter: options.adapter,
			initialState: {
				...options.agentOptions?.initialState,
				systemPrompt,
				thinkingLevel:
					options.agentOptions?.initialState
						?.thinkingLevel ?? 'low',
				tools: [...registry.all, memoryTool]
			},
			onEvent: event => this.handleEvent(event)
		})
	}

	// ── Adapter hot-swap ────────────────────────────────────────────────────

	/** Swap the adapter (e.g. after OAuth token refresh) without destroying the agent. */
	updateAdapter(adapter: AnyTextAdapter): void {
		this.agent.adapter = adapter
		this.options = { ...this.options, adapter }
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

		const history = this.loadHistory(sessionId)

		this.agent.state.systemPrompt = this.baseSystemPrompt
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
					this.agent.followUp({
						role: 'user',
						content: [{ type: 'text', text }],
						timestamp: Date.now()
					})
					routed = 'followUp'
				} else {
					// Different session, agent busy — queue for later
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

			this.agent.runId = runId

			// Run memory recall before prompting (non-blocking on failure)
			await this.runRecall(sessionId, text, runId)

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

		this.handleMessage(sessionId, text).catch(err => {
			console.error(
				`[agent-controller] handleMessage FAILED session=${sessionId}:`,
				err instanceof Error ? err.message : String(err)
			)
		})
	}

	// ── Internal: memory integration ────────────────────────────────────────

	/**
	 * Run memory recall and inject context into the system prompt.
	 * If recall fails, log the error and proceed without memory context.
	 */
	private async runRecall(
		sessionId: string,
		query: string,
		runId: string
	): Promise<void> {
		if (!this.memory) return

		try {
			const result = await this.memory.recall(query)
			if (!result) return

			// Emit memory_recall event
			this.store.appendEvent(
				sessionId,
				'memory_recall',
				result.payload as EventPayloadMap['memory_recall'],
				runId
			)

			// Inject recall context into the system prompt for this run
			if (result.contextBlock) {
				this.agent.state.systemPrompt =
					this.baseSystemPrompt +
					'\n\n' +
					result.contextBlock
			}
		} catch (err) {
			console.error(
				`[agent-controller] memory recall failed session=${sessionId}:`,
				err instanceof Error ? err.message : String(err)
			)
			try {
				this.store.appendEvent(
					sessionId,
					'error',
					{
						message: `Memory recall failed: ${err instanceof Error ? err.message : String(err)}`,
						code: 'memory_recall_failed'
					},
					runId
				)
			} catch {
				// Best-effort error event
			}
		}
	}

	/**
	 * Evaluate and run memory retain after an agent run completes.
	 * Does not block or affect the agent response.
	 */
	private async runRetain(
		sessionId: string,
		runId: string,
		force?: boolean
	): Promise<number> {
		if (!this.memory) return 0

		try {
			const result = await this.memory.evaluateRetain(
				sessionId,
				force
			)
			if (!result) return 0

			// Emit memory_retain event
			this.store.appendEvent(
				sessionId,
				'memory_retain',
				result as EventPayloadMap['memory_retain'],
				runId
			)

			return result.parts[0]?.factsStored ?? 0
		} catch (err) {
			console.error(
				`[agent-controller] memory retain failed session=${sessionId}:`,
				err instanceof Error ? err.message : String(err)
			)
			// Retain failure is non-fatal — cursor stays put for next attempt
			return 0
		}
	}

	/**
	 * Run retain and enforce daily memory write if retain found facts
	 * but the agent didn't call memory_append_daily during this run.
	 */
	private async runRetainAndEnforce(
		sessionId: string,
		runId: string
	): Promise<void> {
		const factsStored = await this.runRetain(
			sessionId,
			runId
		)
		if (factsStored === 0) return

		// Check if the run contained a memory_append_daily call
		const runEvents = this.store.queryRunEvents(
			sessionId,
			runId
		)

		// Check for a successful memory_append_daily call.
		// We look at tool_execution_end / tool_result which carry isError.
		const hadDailyWrite = runEvents.some(e => {
			if (
				e.type !== 'tool_execution_end' &&
				e.type !== 'tool_result'
			)
				return false
			try {
				const parsed = JSON.parse(e.payload)
				const nameMatch =
					parsed.toolName === 'memory_append_daily' ||
					parsed.name === 'memory_append_daily'
				return nameMatch && !parsed.isError
			} catch {
				return false
			}
		})

		if (hadDailyWrite) return

		// Enforcement: trigger a silent follow-up turn
		await this.withLock(async () => {
			if (this.agent.state.isStreaming) return
			if (this.boundSessionId !== sessionId) return

			const enforcementRunId = ulid()
			this.enforcementRunIds.add(enforcementRunId)
			this.agent.runId = enforcementRunId

			this.agent
				.prompt(
					'[SYSTEM] The retain pipeline just stored new facts from this conversation. ' +
						'You MUST call memory_append_daily now to persist any durable facts ' +
						'to daily memory. If there is nothing meaningful to persist, ' +
						'respond with exactly NO_REPLY and nothing else.'
				)
				.catch(err => {
					console.error(
						`[agent-controller] enforcement turn FAILED session=${sessionId}:`,
						err instanceof Error ? err.message : String(err)
					)
				})
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

		// Streaming deltas → publish to SSE subscribers only, no DB write / log.
		if (event.type === 'message_update') {
			// Skip SSE broadcast for enforcement turns (silent)
			if (runId && this.enforcementRunIds.has(runId)) return
			this.store.publishEphemeral(
				sessionId,
				'message_update',
				{
					streamEvent: event.streamEvent,
					message: event.message
				},
				runId ?? undefined
			)
			return
		}

		if (!runId) {
			console.warn(
				`[agent-controller] event received without runId session=${sessionId} type=${event.type} — not persisted`
			)
			return
		}

		// Enforcement runs are silent — skip DB writes and SSE for all events
		// except agent_end (needed to trigger cleanup / queue processing)
		const isEnforcement = this.enforcementRunIds.has(runId)
		if (isEnforcement && event.type !== 'agent_end') return

		// Map every AgentEvent to one or more DB rows and persist.
		// The cast below is safe: TypedEvent guarantees type↔payload
		// correlation, but TypeScript can't track it across the loop.
		const rows = this.mapEventToDb(event)
		for (const row of rows) {
			try {
				this.store.appendEvent(
					sessionId,
					row.type as EventType,
					row.payload as EventPayloadMap[typeof row.type],
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
			try {
				this.store.closeAgentRun(sessionId, runId)
			} catch {
				// Already closed — non-fatal
			}

			// Trigger memory retain, then check for missed daily writes
			// Skip enforcement for enforcement runs to avoid infinite loops
			const isEnforcementRun =
				this.enforcementRunIds.has(runId)
			if (isEnforcementRun) {
				this.enforcementRunIds.delete(runId)
				// Still run retain but skip enforcement check
				this.runRetain(sessionId, runId).catch(err => {
					console.error(
						`[agent-controller] post-enforcement retain error session=${sessionId}:`,
						err instanceof Error ? err.message : String(err)
					)
				})
			} else {
				this.runRetainAndEnforce(sessionId, runId).catch(
					err => {
						console.error(
							`[agent-controller] post-run retain+enforce error session=${sessionId}:`,
							err instanceof Error
								? err.message
								: String(err)
						)
					}
				)
			}

			// Reset system prompt to base (strip recall context from this run)
			this.agent.state.systemPrompt = this.baseSystemPrompt
			this.agent.runId = undefined

			// Check for orphaned follow-ups first (same session)
			if (this.agent.hasQueuedMessages()) {
				queueMicrotask(() => {
					this.withLock(async () => {
						if (
							!this.agent.state.isStreaming &&
							this.agent.hasQueuedMessages()
						) {
							const newRunId = ulid()
							this.agent.runId = newRunId
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
	private mapEventToDb(event: AgentEvent): TypedEvent[] {
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

			// message_update is skipped in handleEvent — never reaches here

			case 'message_end': {
				const msg = event.message
				const rows: TypedEvent[] = [
					{
						type: 'message_end',
						payload: { message: msg }
					}
				]

				// Dual-write: also persist as assistant_final for backward compat
				// Skip truly empty assistant messages (artifacts from multi-turn finalization)
				// but always emit for error/aborted so the client sees the failure
				const hasContent =
					msg.role === 'assistant' &&
					Array.isArray(msg.content) &&
					msg.content.length > 0
				const isErrorOrAborted =
					msg.role === 'assistant' &&
					(msg.stopReason === 'error' ||
						msg.stopReason === 'aborted')
				if (hasContent || isErrorOrAborted) {
					rows.push({
						type: 'assistant_final',
						payload: msg
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

			case 'retry':
				return [
					{
						type: 'retry',
						payload: {
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							reason: event.reason,
							delayMs: event.delayMs
						}
					}
				]

			case 'context_compacted':
				return [
					{
						type: 'context_compacted',
						payload: {
							removedCount: event.removedCount,
							remainingCount: event.remainingCount,
							estimatedTokens: event.estimatedTokens
						}
					}
				]

			case 'tool_loop_detected':
				return [
					{
						type: 'tool_loop_detected',
						payload: {
							pattern: event.pattern,
							toolName: event.toolName,
							message: event.message
						}
					}
				]

			case 'limit_hit':
				return [
					{
						type: 'limit_hit',
						payload: {
							limit: event.limit,
							threshold: event.threshold,
							observed: event.observed,
							usageSnapshot: event.usageSnapshot,
							scope: event.scope,
							action: event.action
						}
					}
				]

			default:
				return []
		}
	}
}
