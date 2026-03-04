import type { Usage } from '@ellie/ai'
import { EventStream } from '../event-stream'
import type {
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AssistantMessage,
	AssistantStreamEvent
} from '../types'
import type { EmitFn } from './types'

export function createAgentStream(): EventStream<
	AgentEvent,
	AgentMessage[]
> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		event => event.type === 'agent_end',
		event =>
			event.type === 'agent_end' ? event.messages : []
	)
}

export function createEmitter(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig
): EmitFn {
	return (event: AgentEvent) => {
		stream.push(event)
		try {
			const result: unknown = config.onEvent?.(event)
			if (result instanceof Promise) {
				result.catch((err: unknown) => {
					console.error(
						'[agent-loop] async onEvent error:',
						err
					)
				})
			}
		} catch (err) {
			console.error('[agent-loop] onEvent error:', err)
		}
	}
}

/** Best-effort Tier 2 trace — never throws. */
export function emitTrace(
	config: AgentLoopConfig,
	type: string,
	payload: Record<string, unknown>
): void {
	try {
		config.onTrace?.({ type, payload })
	} catch {
		// trace is best-effort — swallow to avoid recursion
	}
}

export function createEmptyUsage(): Usage {
	return {
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
	}
}

export function createPartial(
	config: AgentLoopConfig
): AssistantMessage {
	return {
		role: 'assistant',
		content: [],
		provider: config.model.provider,
		model: config.model.id,
		usage: createEmptyUsage(),
		stopReason: 'stop',
		timestamp: Date.now()
	}
}

/**
 * Emit a message_update event with a snapshot of the partial message.
 */
export function emitUpdate(
	emit: EmitFn,
	partial: AssistantMessage,
	streamEvent: AssistantStreamEvent
): void {
	emit({
		type: 'message_update',
		message: { ...partial, content: [...partial.content] },
		streamEvent
	})
}
