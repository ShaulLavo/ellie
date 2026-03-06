/**
 * Trace projector — derives chat/run event rows from a trace journal.
 *
 * Maps trace event kinds to the equivalent EventType that would be
 * written to SQLite by the controller. Used in tests to validate
 * dual-write correctness: the projected events from a trace journal
 * should be equivalent to the direct SQLite writes.
 */

import type { TraceEventEnvelope } from './types'

export interface ProjectedEvent {
	type: string
	traceId: string
	spanId: string
	sessionId?: string
	runId?: string
	ts: number
	payload: unknown
}

/**
 * Map a trace kind to the equivalent DB event type.
 * Returns undefined for trace kinds that don't map to DB events
 * (e.g. trace.root, prompt.snapshot).
 */
function mapKindToEventType(
	kind: string
): string | undefined {
	switch (kind) {
		case 'tool.start':
			return 'tool_execution_start'
		case 'tool.end':
			return 'tool_execution'
		case 'model.response':
			return 'assistant_message'
		case 'model.error':
			return 'error'
		case 'memory.recall.end':
			return 'memory_recall'
		case 'memory.retain.end':
			return 'memory_retain'
		case 'repl.end':
			return 'tool_execution'
		case 'control.steer':
			return 'user_message'
		case 'control.abort':
			return 'abort'
		default:
			return undefined
	}
}

/**
 * Project a trace journal into a sequence of derived events.
 *
 * Filters out trace-only events (trace.root, prompt.snapshot, model.request)
 * that don't have DB equivalents, and maps the rest to their EventType.
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
			sessionId: envelope.sessionId,
			runId: envelope.runId,
			ts: envelope.ts,
			payload: envelope.payload
		})
	}

	return projected
}
