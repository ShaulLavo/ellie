/**
 * Pure mapping of AgentEvents to typed DB event rows.
 *
 * Handles only the non-streaming events that remain durable in SQLite.
 * Streaming events (assistant_message, tool_execution) are handled by
 * stream-persistence.ts via INSERT/UPDATE.
 */

import type { AgentEvent } from '@ellie/agent'
import type { TypedEvent } from '@ellie/schemas/events'

/**
 * Map a non-streaming AgentEvent to DB event rows.
 * Returns an empty array for events handled elsewhere (streaming)
 * or unrecognised event types.
 */
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
