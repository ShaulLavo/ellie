/**
 * Agent class — stateful wrapper around the agent loop.
 *
 * Manages conversation state, event subscriptions, steering/follow-up queues,
 * and delegates to agentLoop/agentLoopContinue for actual execution.
 */

import {
	getModel,
	type Model,
	type ThinkingLevel
} from '@ellie/ai'
import type { AnyTextAdapter } from '@tanstack/ai'
import { agentLoop, agentLoopContinue } from './agent-loop'
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	AssistantMessage,
	ImageContent,
	StreamFn,
	TextContent
} from './types'

export interface AgentOptions {
	initialState?: Partial<AgentState>

	/** TanStack AI adapter (e.g., anthropicText("claude-sonnet-4-6")) */
	adapter?: AnyTextAdapter

	/** Optional transform applied to context before sending to LLM. */
	transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal
	) => Promise<AgentMessage[]>

	/** Maximum LLM call iterations when tools are involved. Default: 10 */
	maxTurns?: number

	/** Steering mode: "all" = send all at once, "one-at-a-time" = one per turn */
	steeringMode?: 'all' | 'one-at-a-time'

	/** Follow-up mode: "all" = send all at once, "one-at-a-time" = one per turn */
	followUpMode?: 'all' | 'one-at-a-time'

	/** Custom stream function (for alternative backends). Default uses TanStack AI chat(). */
	streamFn?: StreamFn

	/** Called for each AgentEvent alongside EventStream.push(). Use for durable persistence. */
	onEvent?: (event: AgentEvent) => void
}

export class Agent {
	private _state: AgentState
	private listeners = new Set<(e: AgentEvent) => void>()
	private abortController?: AbortController
	private transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal
	) => Promise<AgentMessage[]>
	private maxTurns?: number
	private steeringQueue: AgentMessage[] = []
	private steeringQueueIdx = 0
	private followUpQueue: AgentMessage[] = []
	private followUpQueueIdx = 0
	private steeringMode: 'all' | 'one-at-a-time'
	private followUpMode: 'all' | 'one-at-a-time'
	public streamFn?: StreamFn
	public adapter?: AnyTextAdapter
	public onEvent?: (event: AgentEvent) => void
	/** Current run ID. Set by external managers before prompt() and cleared automatically. */
	public runId?: string
	private runningPrompt?: Promise<void>
	private resolveRunningPrompt?: () => void

	constructor(opts: AgentOptions = {}) {
		const defaultModel = getModel(
			'anthropic',
			'claude-sonnet-4-6'
		)
		if (!defaultModel) {
			throw new Error(
				"Default model 'claude-sonnet-4-6' not found in registry — check @ellie/ai model config"
			)
		}
		this._state = {
			systemPrompt: '',
			model: defaultModel,
			thinkingLevel: 'off',
			tools: [],
			messages: [],
			isStreaming: false,
			streamMessage: null,
			error: undefined,
			...opts.initialState
		}
		this.transformContext = opts.transformContext
		this.maxTurns = opts.maxTurns
		this.steeringMode = opts.steeringMode || 'one-at-a-time'
		this.followUpMode = opts.followUpMode || 'one-at-a-time'
		this.streamFn = opts.streamFn
		this.adapter = opts.adapter
		this.onEvent = opts.onEvent
	}

	get state(): AgentState {
		return this._state
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.add(fn)
		return () => this.listeners.delete(fn)
	}

	// --- State mutators ---

	setSystemPrompt(v: string) {
		this._state.systemPrompt = v
	}

	setModel(m: Model) {
		this._state.model = m
	}

	setThinkingLevel(l: ThinkingLevel | 'off') {
		this._state.thinkingLevel = l
	}

	setSteeringMode(mode: 'all' | 'one-at-a-time') {
		this.steeringMode = mode
	}

	getSteeringMode(): 'all' | 'one-at-a-time' {
		return this.steeringMode
	}

	setFollowUpMode(mode: 'all' | 'one-at-a-time') {
		this.followUpMode = mode
	}

	getFollowUpMode(): 'all' | 'one-at-a-time' {
		return this.followUpMode
	}

	setTools(t: AgentTool[]) {
		this._state.tools = t
	}

	replaceMessages(ms: AgentMessage[]) {
		this._state.messages = ms.slice()
	}

	appendMessage(m: AgentMessage) {
		this._state.messages = [...this._state.messages, m]
	}

	clearMessages() {
		this._state.messages = []
	}

	// --- Steering & follow-up queues ---

	steer(m: AgentMessage) {
		this.steeringQueue.push(m)
	}

	followUp(m: AgentMessage) {
		this.followUpQueue.push(m)
	}

	clearSteeringQueue() {
		this.steeringQueue = []
		this.steeringQueueIdx = 0
	}

	clearFollowUpQueue() {
		this.followUpQueue = []
		this.followUpQueueIdx = 0
	}

	clearAllQueues() {
		this.clearSteeringQueue()
		this.clearFollowUpQueue()
	}

	hasQueuedMessages(): boolean {
		return (
			this.steeringQueueIdx < this.steeringQueue.length ||
			this.followUpQueueIdx < this.followUpQueue.length
		)
	}

	private dequeueSteeringMessages(): AgentMessage[] {
		if (this.steeringQueueIdx >= this.steeringQueue.length)
			return []

		if (this.steeringMode === 'one-at-a-time') {
			const first =
				this.steeringQueue[this.steeringQueueIdx++]
			this.compactQueue('steering')
			return [first]
		}
		const remaining = this.steeringQueue.slice(
			this.steeringQueueIdx
		)
		this.steeringQueue = []
		this.steeringQueueIdx = 0
		return remaining
	}

	private dequeueFollowUpMessages(): AgentMessage[] {
		if (this.followUpQueueIdx >= this.followUpQueue.length)
			return []

		if (this.followUpMode === 'one-at-a-time') {
			const first =
				this.followUpQueue[this.followUpQueueIdx++]
			this.compactQueue('followUp')
			return [first]
		}
		const remaining = this.followUpQueue.slice(
			this.followUpQueueIdx
		)
		this.followUpQueue = []
		this.followUpQueueIdx = 0
		return remaining
	}

	private compactQueue(which: 'steering' | 'followUp') {
		const queue =
			which === 'steering'
				? this.steeringQueue
				: this.followUpQueue
		const idx =
			which === 'steering'
				? this.steeringQueueIdx
				: this.followUpQueueIdx
		if (idx > 32 && idx > queue.length / 2) {
			if (which === 'steering') {
				this.steeringQueue = this.steeringQueue.slice(
					this.steeringQueueIdx
				)
				this.steeringQueueIdx = 0
			} else {
				this.followUpQueue = this.followUpQueue.slice(
					this.followUpQueueIdx
				)
				this.followUpQueueIdx = 0
			}
		}
	}

	// --- Lifecycle ---

	abort() {
		this.abortController?.abort()
	}

	waitForIdle(): Promise<void> {
		return this.runningPrompt ?? Promise.resolve()
	}

	reset() {
		this._state.messages = []
		this._state.isStreaming = false
		this._state.streamMessage = null
		this._state.error = undefined
		this.clearAllQueues()
		this.runId = undefined
	}

	// --- Prompting ---

	async prompt(
		message: AgentMessage | AgentMessage[]
	): Promise<void>
	async prompt(
		input: string,
		images?: ImageContent[]
	): Promise<void>
	async prompt(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[]
	) {
		if (this._state.isStreaming) {
			throw new Error(
				'Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.'
			)
		}

		if (!this.adapter) {
			throw new Error(
				'No adapter configured. Pass an adapter via AgentOptions.'
			)
		}

		let msgs: AgentMessage[]

		if (Array.isArray(input)) {
			msgs = input
		} else if (typeof input === 'string') {
			const content: Array<TextContent | ImageContent> = [
				{ type: 'text', text: input }
			]
			if (images && images.length > 0) {
				content.push(...images)
			}
			msgs = [
				{
					role: 'user',
					content,
					timestamp: Date.now()
				}
			]
		} else {
			msgs = [input]
		}

		await this._runLoop(msgs)
	}

	async continue() {
		if (this._state.isStreaming) {
			throw new Error(
				'Agent is already processing. Wait for completion before continuing.'
			)
		}

		const messages = this._state.messages
		if (messages.length === 0) {
			throw new Error('No messages to continue from')
		}

		if (
			messages[messages.length - 1].role === 'assistant'
		) {
			const queuedSteering = this.dequeueSteeringMessages()
			if (queuedSteering.length > 0) {
				await this._runLoop(queuedSteering, {
					skipInitialSteeringPoll: true
				})
				return
			}

			const queuedFollowUp = this.dequeueFollowUpMessages()
			if (queuedFollowUp.length > 0) {
				await this._runLoop(queuedFollowUp)
				return
			}

			throw new Error(
				'Cannot continue from message role: assistant'
			)
		}

		await this._runLoop(undefined)
	}

	// --- Internal ---

	private async _runLoop(
		messages?: AgentMessage[],
		options?: { skipInitialSteeringPoll?: boolean }
	) {
		if (!this.adapter) {
			throw new Error('No adapter configured.')
		}

		console.log(
			`[agent] _runLoop starting model=${this._state.model.id} provider=${this._state.model.provider} messageCount=${messages?.length ?? 0} historyLength=${this._state.messages.length} tools=${this._state.tools.length}`
		)

		this.runningPrompt = new Promise<void>(resolve => {
			this.resolveRunningPrompt = resolve
		})

		this.abortController = new AbortController()
		this._state.isStreaming = true
		this._state.streamMessage = null
		this._state.error = undefined

		const context: AgentContext = {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools
		}

		let skipInitialSteeringPoll =
			options?.skipInitialSteeringPoll === true

		const config: AgentLoopConfig = {
			model: this._state.model,
			adapter: this.adapter,
			thinkingLevel: this._state.thinkingLevel,
			maxTurns: this.maxTurns,
			transformContext: this.transformContext,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false
					return []
				}
				return this.dequeueSteeringMessages()
			},
			getFollowUpMessages: async () =>
				this.dequeueFollowUpMessages(),
			onEvent: this.onEvent
		}

		let partial: AgentMessage | null = null
		let eventCount = 0

		try {
			const stream = messages
				? agentLoop(
						messages,
						context,
						config,
						this.abortController.signal,
						this.streamFn
					)
				: agentLoopContinue(
						context,
						config,
						this.abortController.signal,
						this.streamFn
					)

			console.log(`[agent] consuming event stream…`)

			for await (const event of stream) {
				eventCount++

				switch (event.type) {
					case 'message_start':
						console.log(
							`[agent] event #${eventCount} message_start role=${event.message.role}`
						)
						partial = event.message
						this._state.streamMessage = event.message
						break

					case 'message_update':
						partial = event.message
						this._state.streamMessage = event.message
						break

					case 'message_end': {
						const endMsg = event.message
						const role = endMsg.role
						if (role === 'assistant') {
							const asst = endMsg as AssistantMessage
							const textParts = asst.content
								.filter(c => c.type === 'text')
								.map(c => ('text' in c ? c.text : ''))
							console.log(
								`[agent] event #${eventCount} message_end role=assistant stopReason=${asst.stopReason} errorMessage=${asst.errorMessage ?? 'none'} contentParts=${asst.content.length} text="${textParts.join('').slice(0, 80)}"`
							)
						} else {
							console.log(
								`[agent] event #${eventCount} message_end role=${role}`
							)
						}
						partial = null
						this._state.streamMessage = null
						this.appendMessage(event.message)
						break
					}

					case 'turn_end':
						console.log(
							`[agent] event #${eventCount} turn_end role=${event.message.role}`
						)
						if (
							event.message.role === 'assistant' &&
							(event.message as AssistantMessage)
								.errorMessage
						) {
							this._state.error = (
								event.message as AssistantMessage
							).errorMessage
						}
						break

					case 'agent_end':
						console.log(
							`[agent] event #${eventCount} agent_end messages=${event.messages?.length ?? 0}`
						)
						this._state.isStreaming = false
						this._state.streamMessage = null
						break

					default:
						console.log(
							`[agent] event #${eventCount} ${event.type}`
						)
				}

				this.emit(event)
			}

			console.log(
				`[agent] stream consumed totalEvents=${eventCount}`
			)

			// Handle any remaining partial message
			if (
				partial &&
				partial.role === 'assistant' &&
				(partial as AssistantMessage).content.length > 0
			) {
				const assistantPartial = partial as AssistantMessage
				const hasMeaningfulContent =
					assistantPartial.content.some(
						c =>
							(c.type === 'thinking' &&
								c.thinking.trim().length > 0) ||
							(c.type === 'text' &&
								c.text.trim().length > 0) ||
							(c.type === 'toolCall' &&
								c.name.trim().length > 0)
					)
				if (hasMeaningfulContent) {
					console.log(
						`[agent] appending remaining partial assistant message`
					)
					this.appendMessage(partial)
				} else {
					console.log(
						`[agent] discarding empty partial assistant message`
					)
				}
			}
		} catch (err: unknown) {
			const errorMessage =
				err instanceof Error ? err.message : String(err)
			console.error(
				`[agent] _runLoop CAUGHT ERROR after ${eventCount} events: ${errorMessage}`
			)

			const errorMsg: AgentMessage = {
				role: 'assistant',
				content: [{ type: 'text', text: '' }],
				provider: this._state.model.provider,
				model: this._state.model.id,
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
				stopReason: this.abortController?.signal.aborted
					? 'aborted'
					: 'error',
				errorMessage,
				timestamp: Date.now()
			}

			console.error(
				`[agent] emitting error agent_end stopReason=${errorMsg.stopReason} errorMessage=${errorMessage}`
			)
			this.appendMessage(errorMsg)
			this._state.error = errorMessage
			this.emit({ type: 'agent_end', messages: [errorMsg] })
		} finally {
			console.log(
				`[agent] _runLoop finished totalEvents=${eventCount} error=${this._state.error ?? 'none'}`
			)
			this._state.isStreaming = false
			this._state.streamMessage = null
			this.abortController = undefined
			this.runId = undefined
			this.resolveRunningPrompt?.()
			this.runningPrompt = undefined
			this.resolveRunningPrompt = undefined
		}
	}

	private emit(e: AgentEvent) {
		for (const listener of this.listeners) {
			try {
				listener(e)
			} catch (err) {
				console.error('[Agent] listener error:', err)
			}
		}
	}
}
