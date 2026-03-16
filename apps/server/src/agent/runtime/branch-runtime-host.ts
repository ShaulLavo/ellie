/**
 * BranchRuntimeHost — wraps one Agent instance for one branchId.
 *
 * Owns generic queueing, steer/follow-up handling, abort, run lifecycle,
 * stream persistence, and trace publishing. Does NOT own assistant or
 * coding policy — that comes from the AgentDefinition.
 *
 * Each host is permanently bound to a single branchId at construction time.
 */

import {
	Agent,
	type AgentOptions,
	type AgentEvent,
	type AgentMessage,
	type AgentDefinition,
	type AgentHostServices,
	type NormalizedUserInput
} from '@ellie/agent'
import type { EventType, EventPayloadMap } from '@ellie/db'
import type {
	TraceRecorder,
	BlobSink,
	TraceScope
} from '@ellie/trace'
import { createRootScope } from '@ellie/trace'
import type { AnyTextAdapter } from '@tanstack/ai'
import { ulid } from 'fast-ulid'
import type { RealtimeStore } from '../../lib/realtime-store'
import { mapAgentEventToDb } from '../controller/event-mapper'
import {
	handleStreamingEvent,
	createStreamState,
	resetStreamState,
	flushPendingArtifacts,
	type StreamPersistenceDeps
} from '../controller/stream-persistence'
import { handleControllerError } from '../controller/error-handler'

export interface TraceScopeRef {
	current: TraceScope | undefined
}

interface BranchRuntimeHostOptions {
	adapter: AnyTextAdapter
	definition: AgentDefinition
	services: AgentHostServices
	traceScopeRef: TraceScopeRef
	agentOptions?: Partial<AgentOptions>
	traceRecorder?: TraceRecorder
	blobSink?: BlobSink
}

export class BranchRuntimeHost {
	readonly branchId: string
	private agent: Agent
	private store: RealtimeStore
	private definition: AgentDefinition
	private services: AgentHostServices
	private traceRecorder: TraceRecorder | undefined
	private blobSink: BlobSink | undefined
	private traceScopeRef: TraceScopeRef

	private streamState = createStreamState()
	private lock: Promise<void> = Promise.resolve()
	private pendingFollowUpRows: number[] = []

	constructor(
		branchId: string,
		store: RealtimeStore,
		options: BranchRuntimeHostOptions
	) {
		this.branchId = branchId
		this.store = store
		this.definition = options.definition
		this.services = options.services
		this.traceRecorder = options.traceRecorder
		this.blobSink = options.blobSink
		this.traceScopeRef = options.traceScopeRef

		this.store.ensureBranch(branchId)

		if (this.definition.onBind) {
			this.definition.onBind(branchId, this.services)
		}

		const toolSafety: NonNullable<
			AgentOptions['toolSafety']
		> = this.blobSink ? { blobSink: this.blobSink } : {}

		this.agent = new Agent({
			...options.agentOptions,
			adapter: options.adapter,
			initialState: {
				...options.agentOptions?.initialState,
				thinkingLevel:
					options.agentOptions?.initialState
						?.thinkingLevel ?? 'low'
			},
			toolSafety,
			traceRecorder: this.traceRecorder,
			onEvent: event => this.handleEvent(event),
			onTrace: entry => {
				this.store.publishTraceEphemeral({
					branchId: this.branchId,
					type: entry.type,
					runId: this.agent.runId,
					payload: entry.payload
				})
			}
		})

		// Initialize from definition
		void this.initFromDefinition()
	}

	get agentType(): string {
		return this.definition.agentType
	}

	updateAdapter(adapter: AnyTextAdapter): void {
		this.agent.adapter = adapter
	}

	private async initFromDefinition(): Promise<void> {
		const normalizedInput: NormalizedUserInput = {
			text: '',
			rawText: ''
		}
		const context = await this.definition.buildContext(
			this.branchId,
			normalizedInput,
			this.services
		)

		this.agent.setSystemPrompt(context.systemPrompt)
		if (context.tools.length > 0) {
			this.agent.setTools(context.tools)
		}
		if (context.thinkingLevel) {
			this.agent.setThinkingLevel(context.thinkingLevel)
		}

		const history = this.loadHistory(this.branchId)
		this.agent.replaceMessages(history)
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

	async handleMessage(
		branchId: string,
		text: string,
		userMessageRowId?: number
	): Promise<{
		runId: string
		routed: 'prompt' | 'followUp'
		activeRunId?: string
		traceId?: string
	}> {
		if (branchId !== this.branchId) {
			throw new Error(
				`Host bound to ${this.branchId}, received message for ${branchId}`
			)
		}

		// Normalize input through the definition
		const normalized = this.definition.normalizeUserInput(
			{ text, rawText: text, userMessageRowId },
			this.services
		)

		const runId = ulid()
		let routed: 'prompt' | 'followUp' = 'prompt'
		let activeRunId: string | undefined
		let traceId: string | undefined

		await this.withLock(async () => {
			if (this.agent.state.isStreaming) {
				this.agent.followUp({
					role: 'user',
					content: [
						{ type: 'text', text: normalized.text }
					],
					timestamp: Date.now()
				})
				routed = 'followUp'
				activeRunId = this.agent.runId
				if (userMessageRowId) {
					this.pendingFollowUpRows.push(userMessageRowId)
				}
				return
			}

			// Reload history for fresh state
			const history = this.loadHistory(this.branchId)
			this.agent.replaceMessages(history)
			this.agent.runId = runId

			if (this.traceRecorder) {
				const threadId = this.store.getBranch(
					this.branchId
				)?.threadId
				const scope = createRootScope({
					traceKind: 'chat',
					threadId,
					branchId: this.branchId,
					runId
				})
				this.traceScopeRef.current = scope
				traceId = scope.traceId
				this.agent.updateToolSafety({
					traceScope: scope
				})
				this.traceRecorder.record(
					scope,
					'trace.root',
					'controller',
					{
						branchId: this.branchId,
						runId,
						text: text.slice(0, 200)
					}
				)
			}

			if (userMessageRowId) {
				try {
					this.store.updateEventRunId(
						userMessageRowId,
						runId,
						this.branchId
					)
				} catch (err) {
					handleControllerError(
						(type, payload) => this.trace(type, payload),
						`backfill_runid_failed branch=${this.branchId} runId=${runId} rowId=${userMessageRowId}`,
						'controller.backfill_runid_failed',
						{
							branchId: this.branchId,
							runId,
							userMessageRowId
						},
						err
					)
				}
			}

			// Run beforeRun hook
			if (this.definition.hooks?.beforeRun) {
				const context = await this.definition.buildContext(
					this.branchId,
					normalized,
					this.services
				)
				const updated =
					await this.definition.hooks.beforeRun(
						this.branchId,
						runId,
						context,
						this.services
					)
				this.agent.setSystemPrompt(updated.systemPrompt)
				if (updated.tools.length > 0) {
					this.agent.setTools(updated.tools)
				}
			}

			// Apply skill expansion to the last user message
			if (normalized.text !== text && history.length > 0) {
				const last = history[history.length - 1]
				if (last.role === 'user') {
					last.content = last.content.map(part =>
						part.type === 'text'
							? { ...part, text: normalized.text }
							: part
					)
				}
				this.agent.replaceMessages(history)
			}

			this.agent.continue().catch(err => {
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`continue_failed branch=${this.branchId} runId=${runId}`,
					'controller.continue_failed',
					{ branchId: this.branchId, runId },
					err
				)
				this.writeErrorEvent(this.branchId, runId, err)
			})
		})

		return { runId, routed, activeRunId, traceId }
	}

	steer(
		branchId: string,
		text: string
	): { traceId?: string } {
		if (branchId !== this.branchId) {
			throw new Error(
				`Host bound to ${this.branchId}, received steer for ${branchId}`
			)
		}

		let traceId: string | undefined
		const runId = this.agent.runId
		if (runId) {
			this.store.appendEvent(
				this.branchId,
				'user_message',
				{
					role: 'user',
					content: [{ type: 'text', text }],
					timestamp: Date.now()
				},
				runId
			)
		}

		if (this.traceRecorder && this.traceScopeRef.current) {
			this.traceRecorder.record(
				this.traceScopeRef.current,
				'control.steer',
				'controller',
				{
					branchId: this.branchId,
					text: text.slice(0, 200)
				}
			)
			traceId = this.traceScopeRef.current.traceId
		}

		this.agent.steer({
			role: 'user',
			content: [{ type: 'text', text }],
			timestamp: Date.now()
		})

		return { traceId }
	}

	abort(branchId: string): { traceId?: string } {
		if (branchId !== this.branchId) {
			throw new Error(
				`Host bound to ${this.branchId}, received abort for ${branchId}`
			)
		}

		let traceId: string | undefined
		const runId = this.agent.runId
		if (runId) {
			this.store.appendEvent(
				this.branchId,
				'run_closed',
				{ reason: 'abort' },
				runId
			)
		}

		if (this.traceRecorder && this.traceScopeRef.current) {
			this.traceRecorder.record(
				this.traceScopeRef.current,
				'control.abort',
				'controller',
				{ branchId: this.branchId }
			)
			traceId = this.traceScopeRef.current.traceId
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
		try {
			this.store.publishTraceEphemeral({
				branchId: this.branchId,
				type,
				runId: this.agent.runId,
				payload
			})
		} catch (err) {
			console.warn('[runtime-host] trace failed:', err)
		}
	}

	private handleEvent(event: AgentEvent): void {
		const runId = this.agent.runId
		if (!runId) {
			if (event.type !== 'agent_end') {
				this.trace('controller.event_no_runid', {
					branchId: this.branchId,
					eventType: event.type
				})
			}
			return
		}

		const handled = handleStreamingEvent(
			this.streamDeps,
			this.streamState,
			event,
			this.branchId,
			runId
		)
		if (handled) return

		const rows = mapAgentEventToDb(event)
		for (const row of rows) {
			try {
				this.store.appendEvent(
					this.branchId,
					row.type as EventType,
					row.payload as EventPayloadMap[typeof row.type],
					runId
				)
			} catch (err) {
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`persist_failed branch=${this.branchId} runId=${runId} type=${row.type}`,
					'controller.persist_failed',
					{
						branchId: this.branchId,
						runId,
						dbType: row.type
					},
					err
				)
			}
		}

		if (event.type !== 'agent_end') return

		flushPendingArtifacts(
			this.streamDeps,
			this.streamState,
			this.branchId,
			runId
		)
		resetStreamState(this.streamState)

		try {
			this.store.closeAgentRun(this.branchId, runId)
		} catch (err) {
			console.warn(
				'[runtime-host] closeAgentRun failed:',
				err
			)
		}

		const capturedTraceScope = this.traceScopeRef.current
		this.agent.runId = undefined
		this.traceScopeRef.current = undefined

		this.schedulePostRunWork(
			this.branchId,
			runId,
			capturedTraceScope
		)
	}

	private schedulePostRunWork(
		branchId: string,
		runId: string,
		_traceScope: TraceScope | undefined
	): void {
		void this.withLock(async () => {
			// Run afterRun hook
			if (this.definition.hooks?.afterRun) {
				try {
					await this.definition.hooks.afterRun(
						branchId,
						runId,
						this.services
					)
				} catch (err) {
					handleControllerError(
						(type, payload) => this.trace(type, payload),
						`afterRun_error branch=${branchId} runId=${runId}`,
						'controller.afterrun_error',
						{ branchId, runId },
						err,
						'warn'
					)
				}
			}
		})
			.then(() => {
				this.scheduleNextQueuedWork()
			})
			.catch(err => {
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`post_run_error branch=${branchId} runId=${runId}`,
					'controller.post_run_error',
					{ branchId, runId },
					err,
					'warn'
				)
			})
	}

	private scheduleNextQueuedWork(): void {
		if (this.agent.state.isStreaming) return
		if (this.agent.hasQueuedMessages()) {
			queueMicrotask(() => this.drainQueuedFollowUps())
		}
	}

	private drainQueuedFollowUps(): void {
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
						this.branchId
					)
				} catch (err) {
					handleControllerError(
						(type, payload) => this.trace(type, payload),
						`backfill_followup_failed branch=${this.branchId} runId=${newRunId} rowId=${rowId}`,
						'controller.backfill_followup_failed',
						{
							branchId: this.branchId,
							runId: newRunId,
							rowId
						},
						err
					)
				}
			}

			if (this.traceRecorder) {
				const threadId = this.store.getBranch(
					this.branchId
				)?.threadId
				const scope = createRootScope({
					traceKind: 'follow-up',
					threadId,
					branchId: this.branchId,
					runId: newRunId
				})
				this.traceScopeRef.current = scope
				this.agent.updateToolSafety({
					traceScope: scope
				})
				this.traceRecorder.record(
					scope,
					'trace.root',
					'controller',
					{
						branchId: this.branchId,
						runId: newRunId,
						type: 'follow-up-drain'
					}
				)
			}

			this.agent.continue().catch(err => {
				handleControllerError(
					(type, payload) => this.trace(type, payload),
					`continue_failed (follow-up drain) branch=${this.branchId} runId=${newRunId}`,
					'controller.continue_failed',
					{
						branchId: this.branchId,
						runId: newRunId
					},
					err
				)
				this.writeErrorEvent(this.branchId, newRunId, err)
			})
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
							{
								type: 'text' as const,
								text: errorMessage
							}
						],
						provider: 'system',
						model: 'system',
						usage: {
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
						},
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
