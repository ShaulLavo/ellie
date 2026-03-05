/**
 * Agent controller — single persistent agent with session binding.
 *
 * Orchestration facade: manages locking, session binding, message routing,
 * and agent lifecycle. Delegates to:
 *   - controller-stream-persistence: unified INSERT/UPDATE for streaming rows
 *   - controller-event-mapper: pure mapping for non-streaming events
 *   - controller-memory: recall, retain, and enforcement logic
 */

import {
	Agent,
	type AgentOptions,
	type AgentEvent,
	type AgentMessage
} from '@ellie/agent'
import type { EventType, EventPayloadMap } from '@ellie/db'
import type { AnyTextAdapter } from '@tanstack/ai'
import { ulid } from 'fast-ulid'
import type { RealtimeStore } from '../lib/realtime-store'
import { buildSystemPrompt } from './system-prompt'
import type { MemoryOrchestrator } from './memory-orchestrator'
import { createToolRegistry } from './tools/capability-registry'
import { createMemoryAppendDailyTool } from './tools/memory-daily'
import { mapAgentEventToDb } from './controller-event-mapper'
import {
	runRecall,
	runRetain,
	runRetainAndEnforce,
	type MemoryDeps
} from './controller-memory'
import {
	handleStreamingEvent,
	createStreamState,
	resetStreamState,
	type StreamPersistenceDeps
} from './controller-stream-persistence'

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
	userMessageRowId?: number
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

	/** Streaming row state (owned here, passed to stream-persistence) */
	private streamState = createStreamState()

	/** Global lock — serialises all routing decisions */
	private lock: Promise<void> = Promise.resolve()

	/** Cross-session message queue — processed FIFO when agent becomes idle */
	private crossSessionQueue: QueuedMessage[] = []

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
			onEvent: event => this.handleEvent(event),
			onTrace: entry => {
				const sessionId = this.boundSessionId
				if (!sessionId) return
				this.store.trace({
					sessionId,
					type: entry.type,
					runId: this.agent.runId,
					payload: entry.payload
				})
			}
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

	private bindToSession(sessionId: string): void {
		this.store.ensureSession(sessionId)
		const history = this.loadHistory(sessionId)
		this.agent.state.systemPrompt = this.baseSystemPrompt
		this.agent.replaceMessages(history)
		this.boundSessionId = sessionId
	}

	private ensureBinding(sessionId: string): boolean {
		if (this.boundSessionId !== sessionId) {
			this.bindToSession(sessionId)
			return this.agent.state.messages.length > 0
		}
		if (this.agent.state.messages.length === 0) {
			const history = this.loadHistory(sessionId)
			if (history.length > 0) {
				this.agent.replaceMessages(history)
				return true
			}
		}
		return false
	}

	// ── Message routing (core) ───────────────────────────────────────────────

	async handleMessage(
		sessionId: string,
		text: string,
		userMessageRowId?: number
	): Promise<{
		runId: string
		routed: 'prompt' | 'followUp' | 'queued'
	}> {
		this.store.ensureSession(sessionId)

		const runId = ulid()
		let routed: 'prompt' | 'followUp' | 'queued' = 'prompt'

		await this.withLock(async () => {
			// Agent busy — queue as follow-up or cross-session
			if (this.agent.state.isStreaming) {
				if (this.boundSessionId === sessionId) {
					this.agent.followUp({
						role: 'user',
						content: [{ type: 'text', text }],
						timestamp: Date.now()
					})
					routed = 'followUp'
				} else {
					this.crossSessionQueue.push({
						sessionId,
						text,
						userMessageRowId
					})
					routed = 'queued'
				}
				return
			}

			// Agent idle — bind if needed and start new run
			const historyLoaded = this.ensureBinding(sessionId)

			this.agent.runId = runId

			// Backfill the runId on the already-persisted user_message
			if (userMessageRowId) {
				try {
					this.store.updateEventRunId(
						userMessageRowId,
						runId,
						sessionId
					)
				} catch (err) {
					console.error(
						`[agent-controller] backfill_runid_failed session=${sessionId} runId=${runId} rowId=${userMessageRowId}`,
						err instanceof Error ? err.message : String(err)
					)
					this.trace('controller.backfill_runid_failed', {
						sessionId,
						runId,
						userMessageRowId,
						message:
							err instanceof Error
								? err.message
								: String(err)
					})
				}
			}

			// Run memory recall before prompting
			await runRecall(
				this.memoryDeps,
				sessionId,
				text,
				runId
			)

			if (historyLoaded) {
				this.agent.continue().catch(err => {
					console.error(
						`[agent-controller] continue_failed session=${sessionId} runId=${runId}`,
						err instanceof Error ? err.message : String(err)
					)
					this.trace('controller.continue_failed', {
						sessionId,
						runId,
						message:
							err instanceof Error
								? err.message
								: String(err)
					})
					this.writeErrorEvent(sessionId, runId)
				})
			} else {
				this.agent.prompt(text).catch(err => {
					console.error(
						`[agent-controller] prompt_failed session=${sessionId} runId=${runId}`,
						err instanceof Error ? err.message : String(err)
					)
					this.trace('controller.prompt_failed', {
						sessionId,
						runId,
						message:
							err instanceof Error
								? err.message
								: String(err)
					})
					this.writeErrorEvent(sessionId, runId)
				})
			}
		})

		return { runId, routed }
	}

	// ── Control passthrough ──────────────────────────────────────────────────

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

	abort(sessionId: string): void {
		if (this.boundSessionId !== sessionId) {
			throw new Error(
				`Agent not bound to session ${sessionId}`
			)
		}
		this.agent.abort()
	}

	// ── Queries ──────────────────────────────────────────────────────────────

	loadHistory(sessionId: string): AgentMessage[] {
		return this.store.listAgentMessages(
			sessionId
		) as AgentMessage[]
	}

	hasSession(sessionId: string): boolean {
		return this.store.hasSession(sessionId)
	}

	// ── Internal: dependency bundles for extracted modules ────────────────────

	private get memoryDeps(): MemoryDeps {
		return {
			store: this.store,
			memory: this.memory,
			agent: this.agent,
			baseSystemPrompt: this.baseSystemPrompt,
			enforcementRunIds: this.enforcementRunIds,
			trace: (type, payload) => this.trace(type, payload),
			withLock: fn => this.withLock(fn),
			getBoundSessionId: () => this.boundSessionId
		}
	}

	private get streamDeps(): StreamPersistenceDeps {
		return {
			store: this.store,
			trace: (type, payload) => this.trace(type, payload)
		}
	}

	// ── Internal: trace helper ──────────────────────────────────────────────

	private trace(
		type: string,
		payload: Record<string, unknown>
	): void {
		const sessionId = this.boundSessionId
		if (!sessionId) return
		try {
			this.store.trace({
				sessionId,
				type,
				runId: this.agent.runId,
				payload
			})
		} catch {
			// trace is best-effort
		}
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
		if (!runId) {
			// agent_end can arrive without a runId after cleanup
			if (event.type !== 'agent_end') {
				this.trace('controller.event_no_runid', {
					sessionId,
					eventType: event.type
				})
			}
			return
		}

		// Enforcement runs are silent — skip everything except agent_end
		const isEnforcement = this.enforcementRunIds.has(runId)
		if (isEnforcement && event.type !== 'agent_end') return

		// 1. Try streaming persistence (assistant_message, tool_execution)
		if (!isEnforcement) {
			const handled = handleStreamingEvent(
				this.streamDeps,
				this.streamState,
				event,
				sessionId,
				runId
			)
			if (handled) return
		}

		// 2. Map non-streaming events to DB rows
		const rows = mapAgentEventToDb(event)
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
					`[agent-controller] persist_failed session=${sessionId} runId=${runId} type=${row.type}`,
					err instanceof Error ? err.message : String(err)
				)
				this.trace('controller.persist_failed', {
					sessionId,
					runId,
					dbType: row.type,
					message:
						err instanceof Error ? err.message : String(err)
				})
			}
		}

		// 3. agent_end lifecycle: close run, memory, queue processing
		if (event.type !== 'agent_end') return

		resetStreamState(this.streamState)

		try {
			this.store.closeAgentRun(sessionId, runId)
		} catch {
			// Already closed — non-fatal
		}

		// Memory retain + enforcement
		if (isEnforcement) {
			this.enforcementRunIds.delete(runId)
			runRetain(this.memoryDeps, sessionId, runId).catch(
				err => {
					console.warn(
						`[agent-controller] retain_post_enforcement_error session=${sessionId} runId=${runId}`,
						err instanceof Error ? err.message : String(err)
					)
					this.trace(
						'controller.retain_post_enforcement_error',
						{
							sessionId,
							runId,
							message:
								err instanceof Error
									? err.message
									: String(err)
						}
					)
				}
			)
		} else {
			runRetainAndEnforce(
				this.memoryDeps,
				sessionId,
				runId
			).catch(err => {
				console.warn(
					`[agent-controller] retain_enforce_error session=${sessionId} runId=${runId}`,
					err instanceof Error ? err.message : String(err)
				)
				this.trace('controller.retain_enforce_error', {
					sessionId,
					runId,
					message:
						err instanceof Error ? err.message : String(err)
				})
			})
		}

		// Reset system prompt and clear runId
		this.agent.state.systemPrompt = this.baseSystemPrompt
		this.agent.runId = undefined

		// Process queues
		if (this.agent.hasQueuedMessages()) {
			queueMicrotask(() =>
				this.drainQueuedFollowUps(sessionId)
			)
		} else if (this.crossSessionQueue.length > 0) {
			queueMicrotask(() => {
				this.processCrossSessionQueue()
			})
		}
	}

	// ── Internal: cross-session queue processing ─────────────────────────────

	private drainQueuedFollowUps(sessionId: string): void {
		this.withLock(async () => {
			if (
				this.agent.state.isStreaming ||
				!this.agent.hasQueuedMessages()
			) {
				return
			}
			const newRunId = ulid()
			this.agent.runId = newRunId
			this.agent.continue().catch(err => {
				console.error(
					`[agent-controller] continue_failed (follow-up drain) session=${sessionId} runId=${newRunId}`,
					err instanceof Error ? err.message : String(err)
				)
				this.trace('controller.continue_failed', {
					sessionId,
					runId: newRunId,
					message:
						err instanceof Error ? err.message : String(err)
				})
				this.writeErrorEvent(sessionId, newRunId)
			})
		})
	}

	private processCrossSessionQueue(): void {
		const next = this.crossSessionQueue.shift()
		if (!next) return

		this.handleMessage(
			next.sessionId,
			next.text,
			next.userMessageRowId
		).catch(err => {
			console.error(
				`[agent-controller] cross_session_failed session=${next.sessionId}`,
				err instanceof Error ? err.message : String(err)
			)
			this.trace('controller.cross_session_failed', {
				sessionId: next.sessionId,
				message:
					err instanceof Error ? err.message : String(err)
			})
		})
	}

	// ── Internal: error events ───────────────────────────────────────────────

	private writeErrorEvent(
		sessionId: string,
		runId: string
	): void {
		this.trace('controller.write_error_event', {
			sessionId,
			runId
		})
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
				`[agent-controller] write_error_event_failed session=${sessionId} runId=${runId}`,
				err instanceof Error ? err.message : String(err)
			)
			this.trace('controller.write_error_event_failed', {
				sessionId,
				runId,
				message:
					err instanceof Error ? err.message : String(err)
			})
		}
	}
}
