/**
 * Agent controller — single persistent agent with session binding.
 *
 * Orchestration facade: manages locking, session binding, message routing,
 * and agent lifecycle. Delegates to:
 *   - stream-persistence: unified INSERT/UPDATE for streaming rows
 *   - event-mapper: pure mapping for non-streaming events
 *   - memory: recall and retain (Hindsight only)
 */

import {
	Agent,
	type AgentOptions,
	type AgentEvent,
	type AgentMessage
} from '@ellie/agent'
import type {
	EventType,
	EventPayloadMap,
	EventStore
} from '@ellie/db'
import type {
	TraceRecorder,
	BlobSink,
	TraceScope
} from '@ellie/trace'
import { createRootScope } from '@ellie/trace'
import type { AnyTextAdapter } from '@tanstack/ai'
import { ulid } from 'fast-ulid'
import type { RealtimeStore } from '../../lib/realtime-store'
import { buildSystemPrompt } from '../system-prompt'
import { expandSkillCommand } from '../skills/expand'
import type { Skill } from '../skills/types'
import type { MemoryOrchestrator } from '../memory-orchestrator'
import { createToolRegistry } from '../tools/capability-registry'
import { mapAgentEventToDb } from './event-mapper'
import {
	runRecall,
	runRetain,
	type MemoryDeps
} from './memory'
import {
	handleStreamingEvent,
	createStreamState,
	resetStreamState,
	flushPendingArtifacts,
	type StreamPersistenceDeps
} from './stream-persistence'
import { handleControllerError } from './error-handler'

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0
	}
} as const

interface AgentControllerOptions {
	adapter: AnyTextAdapter
	workspaceDir: string
	dataDir: string
	agentOptions?: Partial<AgentOptions>
	memory?: MemoryOrchestrator
	traceRecorder?: TraceRecorder
	blobSink?: BlobSink
	eventStore?: EventStore
	credentialsPath?: string
}

interface QueuedMessage {
	sessionId: string
	text: string
	userMessageRowId?: number
}

export class AgentController {
	private agent: Agent
	private boundSessionId: string | null = null
	private store: RealtimeStore
	private options: AgentControllerOptions
	private memory: MemoryOrchestrator | null
	private baseSystemPrompt: string
	private skills: Skill[]
	private traceRecorder: TraceRecorder | undefined
	private blobSink: BlobSink | undefined
	/** Active trace scope for the current run */
	private activeTraceScope: TraceScope | undefined

	/** Lazily-cached MemoryDeps — safe to cache for the controller lifetime:
	 *  all deps are stable references (store, memory, agent, baseSystemPrompt)
	 *  or captured via closures that read current values at call time
	 *  (trace). */
	#memoryDeps: MemoryDeps | null = null

	/** Streaming row state (owned here, passed to stream-persistence) */
	private streamState = createStreamState()

	/** Global lock — serialises all routing decisions */
	private lock: Promise<void> = Promise.resolve()

	/** Cross-session message queue — processed FIFO when agent becomes idle */
	private crossSessionQueue: QueuedMessage[] = []

	/** Row IDs of follow-up user_messages awaiting runId backfill */
	private pendingFollowUpRows: number[] = []

	constructor(
		store: RealtimeStore,
		options: AgentControllerOptions
	) {
		this.store = store
		this.options = options
		this.memory = options.memory ?? null
		this.traceRecorder = options.traceRecorder
		this.blobSink = options.blobSink

		const { prompt: systemPrompt, skills } =
			buildSystemPrompt(options.workspaceDir)
		this.baseSystemPrompt = systemPrompt
		this.skills = skills
		const registry = createToolRegistry({
			workspaceDir: options.workspaceDir,
			dataDir: options.dataDir,
			getSessionId: () => this.boundSessionId,
			getRunId: () => this.agent.runId ?? null,
			traceRecorder: this.traceRecorder,
			blobSink: this.blobSink,
			getTraceScope: () => this.activeTraceScope,
			eventStore: options.eventStore,
			credentialsPath: options.credentialsPath
		})

		// Build toolSafety config — blob-backed overflow when available
		const toolSafety: NonNullable<
			AgentOptions['toolSafety']
		> = this.blobSink ? { blobSink: this.blobSink } : {}

		this.agent = new Agent({
			...options.agentOptions,
			adapter: options.adapter,
			initialState: {
				...options.agentOptions?.initialState,
				systemPrompt,
				thinkingLevel:
					options.agentOptions?.initialState
						?.thinkingLevel ?? 'low',
				tools: registry.all
			},
			toolSafety,
			traceRecorder: this.traceRecorder,
			onEvent: event => this.handleEvent(event),
			onTrace: entry => {
				const sessionId = this.boundSessionId
				if (!sessionId) return
				this.store.publishTraceEphemeral({
					sessionId,
					type: entry.type,
					runId: this.agent.runId,
					payload: entry.payload
				})
			}
		})
	}

	/** Swap the adapter (e.g. after OAuth token refresh) without destroying the agent. */
	updateAdapter(adapter: AnyTextAdapter): void {
		this.agent.adapter = adapter
		this.options = { ...this.options, adapter }
	}

	/** Hand-rolled async mutex: each caller chains onto the previous promise,
	 *  serializing execution without a queue data structure. */
	private async withLock(
		fn: () => Promise<void>
	): Promise<void> {
		const prev = this.lock
		// .catch(() => {}) swallows any error from the previous turn so one
		// failure doesn't block all subsequent callers.
		const next = prev.catch(() => {}).then(() => fn())
		this.lock = next
		try {
			await next
		} finally {
			// Only reset if no newer waiter has already replaced this.lock;
			// a stale reference here would clobber a live chain.
			if (this.lock === next) {
				this.lock = Promise.resolve()
			}
		}
	}

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

	async handleMessage(
		sessionId: string,
		text: string,
		userMessageRowId?: number
	): Promise<{
		runId: string
		routed: 'prompt' | 'followUp' | 'queued'
		activeRunId?: string
		traceId?: string
	}> {
		this.store.ensureSession(sessionId)

		// Expand /skill:name commands before any routing
		const expandedText = expandSkillCommand(
			text,
			this.skills
		)

		const runId = ulid()
		let routed: 'prompt' | 'followUp' | 'queued' = 'prompt'
		let activeRunId: string | undefined
		let traceId: string | undefined

		await this.withLock(async () => {
			// Agent busy — queue as follow-up or cross-session
			if (this.agent.state.isStreaming) {
				if (this.boundSessionId === sessionId) {
					this.agent.followUp({
						role: 'user',
						content: [{ type: 'text', text: expandedText }],
						timestamp: Date.now()
					})
					routed = 'followUp'
					activeRunId = this.agent.runId
					if (userMessageRowId) {
						this.pendingFollowUpRows.push(userMessageRowId)
					}
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

			// Agent idle — bind if needed
			this.ensureBinding(sessionId)

			this.agent.runId = runId

			// Create root trace scope for this run
			if (this.traceRecorder) {
				const scope = createRootScope({
					traceKind: 'chat',
					sessionId,
					runId
				})
				this.activeTraceScope = scope
				traceId = scope.traceId

				// Thread trace scope into agent's toolSafety
				this.agent.updateToolSafety({
					traceScope: scope
				})

				this.traceRecorder.record(
					scope,
					'trace.root',
					'controller',
					{ sessionId, runId, text: text.slice(0, 200) }
				)
			}

			// Backfill the runId on the already-persisted user_message
			if (userMessageRowId) {
				try {
					this.store.updateEventRunId(
						userMessageRowId,
						runId,
						sessionId
					)
				} catch (err) {
					handleControllerError(
						(type, payload) => this.trace(type, payload),
						`backfill_runid_failed session=${sessionId} runId=${runId} rowId=${userMessageRowId}`,
						'controller.backfill_runid_failed',
						{ sessionId, runId, userMessageRowId },
						err
					)
				}
			}

			// Run memory recall before prompting
			await runRecall(
				this.memoryDeps,
				sessionId,
				text,
				runId
			)

			// The user_message event is persisted before handleMessage
			// is called. Reload history so the agent has the full
			// content parts (including image data from attachments).
			{
				const history = this.loadHistory(sessionId)

				// If the text was expanded (skill command), patch
				// the last user message so the agent sees the full
				// skill content instead of the raw /skill:name command.
				if (expandedText !== text && history.length > 0) {
					const last = history[history.length - 1]
					if (last.role === 'user') {
						last.content = [
							{ type: 'text', text: expandedText }
						]
					}
				}

				this.agent.replaceMessages(history)
			}
			this.agent.continue().catch(err => {
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`continue_failed session=${sessionId} runId=${runId}`,
					'controller.continue_failed',
					{ sessionId, runId },
					err
				)
				this.writeErrorEvent(sessionId, runId, err)
			})
		})

		return { runId, routed, activeRunId, traceId }
	}

	steer(
		sessionId: string,
		text: string
	): { traceId?: string } {
		if (this.boundSessionId !== sessionId) {
			throw new Error(
				`Agent not bound to session ${sessionId}`
			)
		}

		let traceId: string | undefined

		// Persist steering input as a first-class user_message event
		const runId = this.agent.runId
		if (runId) {
			this.store.appendEvent(
				sessionId,
				'user_message',
				{
					role: 'user',
					content: [{ type: 'text', text }],
					timestamp: Date.now()
				},
				runId
			)
		}

		// Emit control.steer trace event
		if (this.traceRecorder && this.activeTraceScope) {
			this.traceRecorder.record(
				this.activeTraceScope,
				'control.steer',
				'controller',
				{ sessionId, text: text.slice(0, 200) }
			)
			traceId = this.activeTraceScope.traceId
		}

		this.agent.steer({
			role: 'user',
			content: [{ type: 'text', text }],
			timestamp: Date.now()
		})

		return { traceId }
	}

	abort(sessionId: string): { traceId?: string } {
		if (this.boundSessionId !== sessionId) {
			throw new Error(
				`Agent not bound to session ${sessionId}`
			)
		}

		let traceId: string | undefined

		// Persist abort as a control event
		const runId = this.agent.runId
		if (runId) {
			this.store.appendEvent(
				sessionId,
				'run_closed',
				{ reason: 'abort' },
				runId
			)
		}

		// Emit control.abort trace event
		if (this.traceRecorder && this.activeTraceScope) {
			this.traceRecorder.record(
				this.activeTraceScope,
				'control.abort',
				'controller',
				{ sessionId }
			)
			traceId = this.activeTraceScope.traceId
		}

		this.agent.abort()

		return { traceId }
	}

	loadHistory(sessionId: string): AgentMessage[] {
		return this.store.listAgentMessages(sessionId)
	}

	hasSession(sessionId: string): boolean {
		return this.store.hasSession(sessionId)
	}

	private get memoryDeps(): MemoryDeps {
		if (this.#memoryDeps === null) {
			this.#memoryDeps = {
				store: this.store,
				memory: this.memory,
				agent: this.agent,
				baseSystemPrompt: this.baseSystemPrompt,
				trace: (type, payload) => this.trace(type, payload),
				traceRecorder: this.traceRecorder,
				getTraceScope: () => this.activeTraceScope,
				blobSink: this.blobSink
			}
		}
		return this.#memoryDeps
	}

	private createRetainMemoryDeps(
		traceScope: TraceScope | undefined
	): MemoryDeps {
		return {
			...this.memoryDeps,
			getTraceScope: () => traceScope
		}
	}

	private get streamDeps(): StreamPersistenceDeps {
		return {
			store: this.store,
			trace: (type, payload) => this.trace(type, payload)
		}
	}

	private trace(
		type: string,
		payload: Record<string, unknown>
	): void {
		const sessionId = this.boundSessionId
		if (!sessionId) return
		try {
			this.store.publishTraceEphemeral({
				sessionId,
				type,
				runId: this.agent.runId,
				payload
			})
		} catch (err) {
			// trace is best-effort — log but don't propagate
			console.warn('[controller] trace failed:', err)
		}
	}

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

		// 1. Try streaming persistence (assistant_message, tool_execution)
		const handled = handleStreamingEvent(
			this.streamDeps,
			this.streamState,
			event,
			sessionId,
			runId
		)
		if (handled) return

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
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`persist_failed session=${sessionId} runId=${runId} type=${row.type}`,
					'controller.persist_failed',
					{ sessionId, runId, dbType: row.type },
					err
				)
			}
		}

		// 3. agent_end lifecycle: close run, memory, queue processing
		if (event.type !== 'agent_end') return

		// Flush any remaining pending artifacts before resetting state
		flushPendingArtifacts(
			this.streamDeps,
			this.streamState,
			sessionId,
			runId
		)
		resetStreamState(this.streamState)

		try {
			this.store.closeAgentRun(sessionId, runId)
		} catch (err) {
			// Already closed — non-fatal, but log for visibility
			console.warn(
				'[controller] closeAgentRun failed:',
				err
			)
		}

		const retainDeps = this.createRetainMemoryDeps(
			this.activeTraceScope
		)

		// Reset system prompt and clear run state before post-run work.
		this.agent.state.systemPrompt = this.baseSystemPrompt
		this.agent.runId = undefined
		this.activeTraceScope = undefined

		this.schedulePostRunWork(sessionId, runId, retainDeps)
	}

	private schedulePostRunWork(
		sessionId: string,
		runId: string,
		retainDeps: MemoryDeps
	): void {
		void this.withLock(async () => {
			await runRetain(retainDeps, sessionId, runId)
		})
			.then(() => {
				this.scheduleNextQueuedWork(sessionId)
			})
			.catch(err => {
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`retain_error session=${sessionId} runId=${runId}`,
					'controller.retain_error',
					{ sessionId, runId },
					err,
					'warn'
				)
			})
	}

	private scheduleNextQueuedWork(sessionId: string): void {
		if (this.agent.state.isStreaming) return
		if (this.agent.hasQueuedMessages()) {
			queueMicrotask(() =>
				this.drainQueuedFollowUps(sessionId)
			)
			return
		}
		if (this.crossSessionQueue.length === 0) return
		queueMicrotask(() => {
			this.processCrossSessionQueue()
		})
	}

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

			// Backfill pending follow-up user_message rows with this run's id.
			// This publishes 'update' events that the delivery registry
			// watches for, promoting pending row-based targets to run-level.
			const rows = this.pendingFollowUpRows.splice(0)
			for (const rowId of rows) {
				try {
					this.store.updateEventRunId(
						rowId,
						newRunId,
						sessionId
					)
				} catch (err) {
					handleControllerError(
						(type, payload) => this.trace(type, payload),
						`backfill_followup_failed session=${sessionId} runId=${newRunId} rowId=${rowId}`,
						'controller.backfill_followup_failed',
						{
							sessionId,
							runId: newRunId,
							rowId
						},
						err
					)
				}
			}

			// Create root trace scope for the follow-up run
			if (this.traceRecorder) {
				const scope = createRootScope({
					traceKind: 'follow-up',
					sessionId,
					runId: newRunId
				})
				this.activeTraceScope = scope
				this.agent.updateToolSafety({
					traceScope: scope
				})
				this.traceRecorder.record(
					scope,
					'trace.root',
					'controller',
					{
						sessionId,
						runId: newRunId,
						type: 'follow-up-drain'
					}
				)
			}

			this.agent.continue().catch(err => {
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`continue_failed (follow-up drain) session=${sessionId} runId=${newRunId}`,
					'controller.continue_failed',
					{ sessionId, runId: newRunId },
					err
				)
				this.writeErrorEvent(sessionId, newRunId, err)
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
			handleControllerError(
				(type, payload) => this.trace(type, payload),
				`cross_session_failed session=${next.sessionId}`,
				'controller.cross_session_failed',
				{ sessionId: next.sessionId },
				err
			)
		})
	}

	private writeErrorEvent(
		sessionId: string,
		runId: string,
		error?: unknown
	): void {
		const errorMessage =
			error instanceof Error
				? error.message
				: String(error ?? 'Unknown error')

		this.trace('controller.write_error_event', {
			sessionId,
			runId,
			errorMessage
		})

		// Write a visible error assistant_message so the client sees the failure
		try {
			this.store.appendEvent(
				sessionId,
				'assistant_message',
				{
					message: {
						role: 'assistant' as const,
						content: [
							{ type: 'text' as const, text: errorMessage }
						],
						provider: 'system',
						model: 'system',
						usage: EMPTY_USAGE,
						stopReason: 'error' as const,
						errorMessage,
						timestamp: Date.now()
					},
					streaming: false
				},
				runId
			)
		} catch (err) {
			handleControllerError(
				(type, payload) => this.trace(type, payload),
				`write_error_message_failed session=${sessionId} runId=${runId}`,
				'controller.write_error_message_failed',
				{ sessionId, runId },
				err
			)
		}

		try {
			this.store.closeAgentRun(sessionId, runId)
		} catch (err) {
			handleControllerError(
				(type, payload) => this.trace(type, payload),
				`write_error_event_failed session=${sessionId} runId=${runId}`,
				'controller.write_error_event_failed',
				{ sessionId, runId },
				err
			)
		}
	}
}
