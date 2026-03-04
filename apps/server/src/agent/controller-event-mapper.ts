/**
 * Pure mapping of AgentEvents to typed DB event rows.
 *
 * Handles only non-streaming events (lifecycle, resilience, guardrails).
 * Streaming events (assistant_message, tool_execution) are handled by
 * controller-stream-persistence.ts via INSERT/UPDATE.
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

		case 'retry':
			return [
				{
					type: 'retry',
					payload: {
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						reason: event.reason,
						delayMs: event.delayMs
					}
				}
			]

		case 'context_compacted':
			return [
				{
					type: 'context_compacted',
					payload: {
						removedCount: event.removedCount,
						remainingCount: event.remainingCount,
						estimatedTokens: event.estimatedTokens
					}
				}
			]

		case 'tool_loop_detected':
			return [
				{
					type: 'tool_loop_detected',
					payload: {
						pattern: event.pattern,
						toolName: event.toolName,
						message: event.message
					}
				}
			]

		case 'limit_hit':
			return [
				{
					type: 'limit_hit',
					payload: {
						limit: event.limit,
						threshold: event.threshold,
						observed: event.observed,
						usageSnapshot: event.usageSnapshot,
						scope: event.scope,
						action: event.action
					}
				}
			]

		default:
			return []
	}
}
