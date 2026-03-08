/**
 * Agent loop — orchestrates multi-turn LLM conversations with tool execution.
 *
 * Delegates the tool-call/re-call loop to TanStack AI's chat() with
 * agentLoopStrategy: maxIterations(). Handles steering (mid-execution
 * interrupts) and follow-up messages as an outer loop.
 */

import { EventStream } from '../event-stream'
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	StreamFn
} from '../types'
import {
	createAgentStream,
	createEmitter,
	emitTrace
} from './helpers'
import { runLoop } from './run-loop'

/**
 * Start an agent loop with new prompt messages.
 * Prompts are added to context and events are emitted for them.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream()
	const emit = createEmitter(stream, config)

	async function run() {
		try {
			const newMessages: AgentMessage[] = [...prompts]
			const currentContext: AgentContext = {
				...context,
				messages: [...context.messages, ...prompts]
			}

			emit({ type: 'agent_start' })
			emit({ type: 'turn_start' })

			for (const prompt of prompts) {
				emit({ type: 'message_start', message: prompt })
				emit({ type: 'message_end', message: prompt })
			}

			await runLoop(
				currentContext,
				newMessages,
				config,
				signal,
				stream,
				emit,
				streamFn
			)
		} catch (err) {
			emitTrace(config, 'agent_loop.error', {
				phase: 'agentLoop',
				message:
					err instanceof Error ? err.message : String(err)
			})
			console.error(
				`[agent-loop] agentLoop top-level CATCH:`,
				err instanceof Error ? err.message : String(err)
			)
			// Propagate error to the consumer (agent._runLoop)
			// so it emits a visible error assistant message.
			stream.error(
				err instanceof Error ? err : new Error(String(err))
			)
		}
	}

	run()

	return stream
}

/**
 * Continue an agent loop from the current context without adding new messages.
 * Used for retries — context already has user message or tool results.
 *
 * The last message must be a user or toolResult.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error(
			'Cannot continue: no messages in context'
		)
	}
	if (
		context.messages[context.messages.length - 1].role ===
		'assistant'
	) {
		throw new Error(
			'Cannot continue from message role: assistant'
		)
	}

	const stream = createAgentStream()
	const emit = createEmitter(stream, config)

	async function run() {
		try {
			const newMessages: AgentMessage[] = []
			const currentContext: AgentContext = { ...context }

			emit({ type: 'agent_start' })
			emit({ type: 'turn_start' })

			await runLoop(
				currentContext,
				newMessages,
				config,
				signal,
				stream,
				emit,
				streamFn
			)
		} catch (err) {
			emitTrace(config, 'agent_loop.error', {
				phase: 'agentLoopContinue',
				message:
					err instanceof Error ? err.message : String(err)
			})
			console.error(
				`[agent-loop] agentLoopContinue top-level CATCH:`,
				err instanceof Error ? err.message : String(err)
			)
			// Propagate error to the consumer (agent._runLoop)
			// so it emits a visible error assistant message.
			stream.error(
				err instanceof Error ? err : new Error(String(err))
			)
		}
	}

	run()

	return stream
}
