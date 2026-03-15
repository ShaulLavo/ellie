/**
 * Agent controller — single persistent agent with branch binding.
 *
 * Orchestration facade: manages locking, branch binding, message routing,
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
	branchId: string
	text: string
	userMessageRowId?: number
}

export class AgentController {
	private agent: Agent
	private boundBranchId: string | null = null
	private store: RealtimeStore
	private options: AgentControllerOptions
	private memory: MemoryOrchestrator | null
	private baseSystemPrompt: string
	private skills: Skill[]
	private traceRecorder: TraceRecorder | undefined
	private blobSink: BlobSink | undefined
	/** Active trace scope for the current run */
	private activeTraceScope: TraceScope | undefined

	/** Lazily-cached MemoryDeps */
	#memoryDeps: MemoryDeps | null = null

	/** Streaming row state (owned here, passed to stream-persistence) */
	private streamState = createStreamState()

	/** Global lock — serialises all routing decisions */
	private lock: Promise<void> = Promise.resolve()

	/** Cross-branch message queue — processed FIFO when agent becomes idle */
	private crossBranchQueue: QueuedMessage[] = []

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
			getBranchId: () => this.boundBranchId,
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
				const branchId = this.boundBranchId
				if (!branchId) return
				this.store.publishTraceEphemeral({
					branchId,
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

	private bindToBranch(branchId: string): void {
		this.store.ensureBranch(branchId)
		const history = this.loadHistory(branchId)
		this.agent.state.systemPrompt = this.baseSystemPrompt
		this.agent.replaceMessages(history)
		this.boundBranchId = branchId
	}

	private ensureBinding(branchId: string): boolean {
		if (this.boundBranchId !== branchId) {
			this.bindToBranch(branchId)
			return this.agent.state.messages.length > 0
		}
		if (this.agent.state.messages.length === 0) {
			const history = this.loadHistory(branchId)
			if (history.length > 0) {
				this.agent.replaceMessages(history)
				return true
			}
		}
		return false
	}

	async handleMessage(
		branchId: string,
		text: string,
		userMessageRowId?: number
	): Promise<{
		runId: string
		routed: 'prompt' | 'followUp' | 'queued'
		activeRunId?: string
		traceId?: string
	}> {
		this.store.ensureBranch(branchId)

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
			// Agent busy — queue as follow-up or cross-branch
			if (this.agent.state.isStreaming) {
				if (this.boundBranchId === branchId) {
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
					this.crossBranchQueue.push({
						branchId,
						text,
						userMessageRowId
					})
					routed = 'queued'
				}
				return
			}

			// Agent idle — bind if needed
			this.ensureBinding(branchId)

			this.agent.runId = runId

			// Create root trace scope for this run
			if (this.traceRecorder) {
				const scope = createRootScope({
					traceKind: 'chat',
					branchId,
					runId
				})
				this.activeTraceScope = scope
				traceId = scope.traceId

				this.agent.updateToolSafety({
					traceScope: scope
				})

				this.traceRecorder.record(
					scope,
					'trace.root',
					'controller',
					{ branchId, runId, text: text.slice(0, 200) }
				)
			}

			// Backfill the runId on the already-persisted user_message
			if (userMessageRowId) {
				try {
					this.store.updateEventRunId(
						userMessageRowId,
						runId,
						branchId
					)
				} catch (err) {
					handleControllerError(
						(type, payload) => this.trace(type, payload),
						`backfill_runid_failed branch=${branchId} runId=${runId} rowId=${userMessageRowId}`,
						'controller.backfill_runid_failed',
						{ branchId, runId, userMessageRowId },
						err
					)
				}
			}

			// TODO: skip recall for skill commands — sending `/skill:foo` to recall is useless
			await runRecall(
				this.memoryDeps,
				branchId,
				text,
				runId
			)

			{
				const history = this.loadHistory(branchId)

				if (expandedText !== text && history.length > 0) {
					const last = history[history.length - 1]
					if (last.role === 'user') {
						last.content = last.content.map(part =>
							part.type === 'text'
								? { ...part, text: expandedText }
								: part
						)
					}
				}

				this.agent.replaceMessages(history)
			}
			this.agent.continue().catch(err => {
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`continue_failed branch=${branchId} runId=${runId}`,
					'controller.continue_failed',
					{ branchId, runId },
					err
				)
				this.writeErrorEvent(branchId, runId, err)
			})
		})

		return { runId, routed, activeRunId, traceId }
	}

	steer(
		branchId: string,
		text: string
	): { traceId?: string } {
		if (this.boundBranchId !== branchId) {
			throw new Error(
				`Agent not bound to branch ${branchId}`
			)
		}

		let traceId: string | undefined

		const runId = this.agent.runId
		if (runId) {
			this.store.appendEvent(
				branchId,
				'user_message',
				{
					role: 'user',
					content: [{ type: 'text', text }],
					timestamp: Date.now()
				},
				runId
			)
		}

		if (this.traceRecorder && this.activeTraceScope) {
			this.traceRecorder.record(
				this.activeTraceScope,
				'control.steer',
				'controller',
				{ branchId, text: text.slice(0, 200) }
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

	abort(branchId: string): { traceId?: string } {
		if (this.boundBranchId !== branchId) {
			throw new Error(
				`Agent not bound to branch ${branchId}`
			)
		}

		let traceId: string | undefined

		const runId = this.agent.runId
		if (runId) {
			this.store.appendEvent(
				branchId,
				'run_closed',
				{ reason: 'abort' },
				runId
			)
		}

		if (this.traceRecorder && this.activeTraceScope) {
			this.traceRecorder.record(
				this.activeTraceScope,
				'control.abort',
				'controller',
				{ branchId }
			)
			traceId = this.activeTraceScope.traceId
		}

		this.agent.abort()

		return { traceId }
	}

	loadHistory(branchId: string): AgentMessage[] {
		return this.store.listAgentMessages(branchId)
	}

	hasBranch(branchId: string): boolean {
		return this.store.hasBranch(branchId)
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
		const branchId = this.boundBranchId
		if (!branchId) return
		try {
			this.store.publishTraceEphemeral({
				branchId,
				type,
				runId: this.agent.runId,
				payload
			})
		} catch (err) {
			console.warn('[controller] trace failed:', err)
		}
	}

	private handleEvent(event: AgentEvent): void {
		const branchId = this.boundBranchId
		if (!branchId) {
			console.warn(
				`[agent-controller] event received without bound branch type=${event.type} — not persisted`
			)
			return
		}

		const runId = this.agent.runId
		if (!runId) {
			if (event.type !== 'agent_end') {
				this.trace('controller.event_no_runid', {
					branchId,
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
			branchId,
			runId
		)
		if (handled) return

		// 2. Map non-streaming events to DB rows
		const rows = mapAgentEventToDb(event)
		for (const row of rows) {
			try {
				this.store.appendEvent(
					branchId,
					row.type as EventType,
					row.payload as EventPayloadMap[typeof row.type],
					runId
				)
			} catch (err) {
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`persist_failed branch=${branchId} runId=${runId} type=${row.type}`,
					'controller.persist_failed',
					{ branchId, runId, dbType: row.type },
					err
				)
			}
		}

		// 3. agent_end lifecycle: close run, memory, queue processing
		if (event.type !== 'agent_end') return

		flushPendingArtifacts(
			this.streamDeps,
			this.streamState,
			branchId,
			runId
		)
		resetStreamState(this.streamState)

		try {
			this.store.closeAgentRun(branchId, runId)
		} catch (err) {
			console.warn(
				'[controller] closeAgentRun failed:',
				err
			)
		}

		const retainDeps = this.createRetainMemoryDeps(
			this.activeTraceScope
		)

		this.agent.state.systemPrompt = this.baseSystemPrompt
		this.agent.runId = undefined
		this.activeTraceScope = undefined

		this.schedulePostRunWork(branchId, runId, retainDeps)
	}

	private schedulePostRunWork(
		branchId: string,
		runId: string,
		retainDeps: MemoryDeps
	): void {
		void this.withLock(async () => {
			await runRetain(retainDeps, branchId, runId)
		})
			.then(() => {
				this.scheduleNextQueuedWork(branchId)
			})
			.catch(err => {
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`retain_error branch=${branchId} runId=${runId}`,
					'controller.retain_error',
					{ branchId, runId },
					err,
					'warn'
				)
			})
	}

	private scheduleNextQueuedWork(branchId: string): void {
		if (this.agent.state.isStreaming) return
		if (this.agent.hasQueuedMessages()) {
			queueMicrotask(() =>
				this.drainQueuedFollowUps(branchId)
			)
			return
		}
		if (this.crossBranchQueue.length === 0) return
		queueMicrotask(() => {
			this.processCrossBranchQueue()
		})
	}

	private drainQueuedFollowUps(branchId: string): void {
		this.withLock(async () => {
			if (
				this.agent.state.isStreaming ||
				!this.agent.hasQueuedMessages()
			) {
				return
			}
			const newRunId = ulid()
			this.agent.runId = newRunId

			const rows = this.pendingFollowUpRows.splice(0)
			for (const rowId of rows) {
				try {
					this.store.updateEventRunId(
						rowId,
						newRunId,
						branchId
					)
				} catch (err) {
					handleControllerError(
						(type, payload) => this.trace(type, payload),
						`backfill_followup_failed branch=${branchId} runId=${newRunId} rowId=${rowId}`,
						'controller.backfill_followup_failed',
						{
							branchId,
							runId: newRunId,
							rowId
						},
						err
					)
				}
			}

			if (this.traceRecorder) {
				const scope = createRootScope({
					traceKind: 'follow-up',
					branchId,
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
						branchId,
						runId: newRunId,
						type: 'follow-up-drain'
					}
				)
			}

			this.agent.continue().catch(err => {
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`continue_failed (follow-up drain) branch=${branchId} runId=${newRunId}`,
					'controller.continue_failed',
					{ branchId, runId: newRunId },
					err
				)
				this.writeErrorEvent(branchId, newRunId, err)
			})
		})
	}

	private processCrossBranchQueue(): void {
		const next = this.crossBranchQueue.shift()
		if (!next) return

		this.handleMessage(
			next.branchId,
			next.text,
			next.userMessageRowId
		).catch(err => {
			handleControllerError(
				(type, payload) => this.trace(type, payload),
				`cross_branch_failed branch=${next.branchId}`,
				'controller.cross_branch_failed',
				{ branchId: next.branchId },
				err
			)
		})
	}

	private writeErrorEvent(
		branchId: string,
		runId: string,
		error?: unknown
	): void {
		const errorMessage =
			error instanceof Error
				? error.message
				: String(error ?? 'Unknown error')

		this.trace('controller.write_error_event', {
			branchId,
			runId,
			errorMessage
		})

		try {
			this.store.appendEvent(
				branchId,
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
				`write_error_message_failed branch=${branchId} runId=${runId}`,
				'controller.write_error_message_failed',
				{ branchId, runId },
				err
			)
		}

		try {
			this.store.closeAgentRun(branchId, runId)
		} catch (err) {
			handleControllerError(
				(type, payload) => this.trace(type, payload),
				`write_error_event_failed branch=${branchId} runId=${runId}`,
				'controller.write_error_event_failed',
				{ branchId, runId },
				err
			)
		}
	}
}
