import type { AgentEvent } from '@ellie/agent'
import type { TypedEvent } from '@ellie/schemas/events'

export function mapAgentEventToDb(
	event: AgentEvent
): TypedEvent[] {
	switch (event.type) {
		case 'agent_start':
			return [{ type: 'agent_start', payload: {} }]
		default:
			return []
	}
}
