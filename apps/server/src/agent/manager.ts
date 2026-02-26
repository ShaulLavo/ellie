/**
 * Server-side agent manager — manages Agent instances keyed by sessionId.
 *
 * Wires each agent's onEvent callback to persist events via the RealtimeStore,
 * and exposes control methods used by HTTP routes.
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
import type { RealtimeStore } from '../lib/realtime-store'

export interface AgentManagerOptions {
	/** TanStack AI adapter for LLM calls */
	adapter: AnyTextAdapter
	/** Default system prompt for new agents */
	systemPrompt?: string
	/** Additional AgentOptions passed to each new Agent */
	agentOptions?: Partial<AgentOptions>
}

export class AgentManager {
	private agents = new Map<string, Agent>()
	private store: RealtimeStore
	private options: AgentManagerOptions

	constructor(
		store: RealtimeStore,
		options: AgentManagerOptions
	) {
		this.store = store
		this.options = options
	}

	/**
	 * Get or create an Agent for a session.
	 * Creates the session if it doesn't exist.
	 */
	getOrCreate(sessionId: string): Agent {
		let agent = this.agents.get(sessionId)
		if (agent) return agent

		this.store.ensureSession(sessionId)

		agent = new Agent({
			...this.options.agentOptions,
			adapter: this.options.adapter,
			initialState: {
				...this.options.agentOptions?.initialState,
				systemPrompt: this.options.systemPrompt ?? ''
			},
			onEvent: event => this.handleEvent(sessionId, event)
		})

		this.agents.set(sessionId, agent)
		return agent
	}

	/**
	 * Send a text prompt to an agent.
	 * Creates the agent if it doesn't exist. Loads history on first use.
	 * Persists the user message and starts the agent run.
	 * Returns the runId for event stream subscription.
	 */
	async prompt(
		sessionId: string,
		text: string
	): Promise<{ runId: string }> {
		// Persist the user message as an event
		this.store.ensureSession(sessionId)
		this.store.appendEvent(sessionId, 'user_message', {
			role: 'user',
			content: [{ type: 'text', text }],
			timestamp: Date.now()
		})

		return this.runAgent(sessionId, text)
	}

	/**
	 * Start an agent run for a message that is already persisted.
	 * Creates the agent if needed, loads history, and kicks off
	 * the prompt. Returns the runId for event stream subscription.
	 */
	async runAgent(
		sessionId: string,
		text: string
	): Promise<{ runId: string }> {
		console.log(
			`[agent-manager] runAgent session=${sessionId} text=${text.slice(0, 100)}`
		)
		const agent = this.getOrCreate(sessionId)

		// Load history if this is a fresh agent with no messages
		if (agent.state.messages.length === 0) {
			const history = this.loadHistory(sessionId)
			console.log(
				`[agent-manager] loaded ${history.length} history messages for session=${sessionId}`
			)
			if (history.length > 0) {
				agent.replaceMessages(history)
			}
		}

		// Pre-flight checks — surface sync errors as HTTP errors to the caller
		if (agent.state.isStreaming) {
			console.warn(
				`[agent-manager] agent busy session=${sessionId}, rejecting`
			)
			throw new Error(
				'Agent is already processing a prompt.'
			)
		}
		if (!agent.adapter) {
			console.error(
				`[agent-manager] no adapter session=${sessionId}`
			)
			throw new Error('No adapter configured for agent.')
		}

		const runId = ulid()
		console.log(
			`[agent-manager] starting prompt session=${sessionId} runId=${runId}`
		)

		// Store the runId so the event handler knows where to write
		agent.runId = runId

		// Start the prompt (non-blocking — events flow via onEvent)
		agent.prompt(text).catch(err => {
			console.error(
				`[agent-manager] prompt FAILED session=${sessionId} runId=${runId}:`,
				err instanceof Error ? err.message : String(err)
			)
			// Write a terminal event so the client doesn't hang
			this.writeErrorEvent(sessionId, runId)
		})

		return { runId }
	}

	/**
	 * Queue a steering message for the running agent.
	 */
	steer(sessionId: string, text: string): void {
		const agent = this.agents.get(sessionId)
		if (!agent)
			throw new Error(
				`Agent not found for session ${sessionId}`
			)

		agent.steer({
			role: 'user',
			content: [{ type: 'text', text }],
			timestamp: Date.now()
		})
	}

	/**
	 * Abort the running agent prompt.
	 */
	abort(sessionId: string): void {
		const agent = this.agents.get(sessionId)
		if (!agent)
			throw new Error(
				`Agent not found for session ${sessionId}`
			)
		agent.abort()
	}

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

	/**
	 * Remove an agent from memory (does not delete the session).
	 * If the agent is actively streaming, eviction is deferred until the run completes.
	 */
	evict(sessionId: string): void {
		const agent = this.agents.get(sessionId)
		if (agent?.state.isStreaming) {
			const unsub = agent.subscribe(e => {
				if (e.type === 'agent_end') {
					unsub()
					this.agents.delete(sessionId)
				}
			})
			return
		}
		this.agents.delete(sessionId)
	}

	// -- Internal ---

	private writeErrorEvent(
		sessionId: string,
		runId: string
	): void {
		console.error(
			`[agent-manager] writing error event session=${sessionId} runId=${runId}`
		)
		try {
			this.store.appendEvent(
				sessionId,
				'error',
				{ message: 'Agent prompt failed unexpectedly' },
				runId
			)
			this.store.closeAgentRun(sessionId, runId)
		} catch (err) {
			console.error(
				`[agent-manager] writeErrorEvent failed session=${sessionId} runId=${runId}:`,
				err instanceof Error ? err.message : String(err)
			)
		}
	}

	private handleEvent(
		sessionId: string,
		event: AgentEvent
	): void {
		const agent = this.agents.get(sessionId)
		const runId = agent?.runId

		// Log every event flowing through the pipeline
		const eventSummary = this.summarizeEvent(event)
		console.log(
			`[agent-manager] event session=${sessionId} runId=${runId ?? 'none'} ${eventSummary}`
		)

		if (!runId) {
			console.warn(
				`[agent-manager] event received without runId session=${sessionId} type=${event.type} — not persisted`
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
					`[agent-manager] failed to persist event session=${sessionId} runId=${runId} dbType=${row.type}:`,
					err instanceof Error ? err.message : String(err)
				)
			}
		}

		// On agent_end, close the run
		if (event.type === 'agent_end') {
			console.log(
				`[agent-manager] closing run session=${sessionId} runId=${runId}`
			)
			try {
				this.store.closeAgentRun(sessionId, runId)
			} catch {
				// Already closed — non-fatal
			}
			if (agent) {
				agent.runId = undefined
			}
		}
	}

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
						payload: { messages: event.messages }
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
