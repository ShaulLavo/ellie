/**
 * Trace projector — derives the durable SQLite event equivalents from a trace journal.
 *
 * Maps trace event kinds to the durable EventType still written to SQLite.
 * Trace-only operational detail stays in JSONL and is intentionally omitted.
 */

import type { TraceEventEnvelope } from './types'

export interface ProjectedEvent {
	type: string
	traceId: string
	spanId: string
	branchId?: string
	runId?: string
	ts: number
	payload: unknown
}

/**
 * Map a trace kind to the equivalent durable DB event type.
 * Returns undefined for trace-only kinds and non-durable controller internals.
 */
function mapKindToEventType(
	kind: string
): string | undefined {
	switch (kind) {
		case 'tool.end':
			return 'tool_execution'
		case 'model.response':
			return 'assistant_message'
		case 'repl.end':
			return 'tool_execution'
		case 'control.steer':
			return 'user_message'
		case 'control.abort':
			return 'run_closed'
		default:
			return undefined
	}
}

/**
 * Project a trace journal into a sequence of derived events.
 *
 * Filters out trace-only events and maps the rest to durable EventTypes.
 */
export function projectTraceToEvents(
	traceEvents: TraceEventEnvelope[]
): ProjectedEvent[] {
	const projected: ProjectedEvent[] = []

	for (const envelope of traceEvents) {
		const eventType = mapKindToEventType(envelope.kind)
		if (!eventType) continue

		projected.push({
			type: eventType,
			traceId: envelope.traceId,
			spanId: envelope.spanId,
			branchId: envelope.branchId,
			runId: envelope.runId,
			ts: envelope.ts,
			payload: envelope.payload
		})
	}

	return projected
}
