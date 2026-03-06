import { describe, test, expect } from 'bun:test'
import { projectTraceToEvents } from '../projector'
import type { TraceEventEnvelope } from '../types'

function makeEnvelope(
	overrides: Partial<TraceEventEnvelope>
): TraceEventEnvelope {
	return {
		eventId: 'evt-1',
		traceId: 'trace-1',
		spanId: 'span-1',
		traceKind: 'chat',
		kind: 'test',
		ts: 1000,
		seq: 0,
		component: 'test',
		payload: {},
		...overrides
	}
}

describe('projectTraceToEvents', () => {
	test('filters out tool.start because it is not durable', () => {
		const events = [makeEnvelope({ kind: 'tool.start' })]
		const projected = projectTraceToEvents(events)
		expect(projected).toHaveLength(0)
	})

	test('maps tool.end to tool_execution', () => {
		const events = [makeEnvelope({ kind: 'tool.end' })]
		const projected = projectTraceToEvents(events)
		expect(projected).toHaveLength(1)
		expect(projected[0].type).toBe('tool_execution')
	})

	test('maps model.response to assistant_message', () => {
		const events = [
			makeEnvelope({ kind: 'model.response' })
		]
		const projected = projectTraceToEvents(events)
		expect(projected).toHaveLength(1)
		expect(projected[0].type).toBe('assistant_message')
	})

	test('filters out model.error because errors are reconstructed from messages/traces', () => {
		const events = [makeEnvelope({ kind: 'model.error' })]
		const projected = projectTraceToEvents(events)
		expect(projected).toHaveLength(0)
	})

	test('filters out memory.recall.end because memory diagnostics are trace-only', () => {
		const events = [
			makeEnvelope({ kind: 'memory.recall.end' })
		]
		const projected = projectTraceToEvents(events)
		expect(projected).toHaveLength(0)
	})

	test('filters out memory.retain.end because memory diagnostics are trace-only', () => {
		const events = [
			makeEnvelope({ kind: 'memory.retain.end' })
		]
		const projected = projectTraceToEvents(events)
		expect(projected).toHaveLength(0)
	})

	test('maps repl.end to tool_execution', () => {
		const events = [makeEnvelope({ kind: 'repl.end' })]
		const projected = projectTraceToEvents(events)
		expect(projected).toHaveLength(1)
		expect(projected[0].type).toBe('tool_execution')
	})

	test('maps control.steer to user_message', () => {
		const events = [makeEnvelope({ kind: 'control.steer' })]
		const projected = projectTraceToEvents(events)
		expect(projected).toHaveLength(1)
		expect(projected[0].type).toBe('user_message')
	})

	test('maps control.abort to run_closed', () => {
		const events = [makeEnvelope({ kind: 'control.abort' })]
		const projected = projectTraceToEvents(events)
		expect(projected).toHaveLength(1)
		expect(projected[0].type).toBe('run_closed')
	})

	test('filters out trace-only events', () => {
		const events = [
			makeEnvelope({ kind: 'trace.root' }),
			makeEnvelope({ kind: 'prompt.snapshot' }),
			makeEnvelope({ kind: 'model.request' }),
			makeEnvelope({ kind: 'memory.recall.start' }),
			makeEnvelope({ kind: 'memory.retain.start' }),
			makeEnvelope({ kind: 'repl.start' })
		]
		const projected = projectTraceToEvents(events)
		expect(projected).toHaveLength(0)
	})

	test('preserves trace metadata on projected events', () => {
		const events = [
			makeEnvelope({
				kind: 'tool.end',
				traceId: 'tr-1',
				spanId: 'sp-1',
				sessionId: 'sess-1',
				runId: 'run-1',
				ts: 12345,
				payload: { toolName: 'search' }
			})
		]
		const projected = projectTraceToEvents(events)
		expect(projected[0].traceId).toBe('tr-1')
		expect(projected[0].spanId).toBe('sp-1')
		expect(projected[0].sessionId).toBe('sess-1')
		expect(projected[0].runId).toBe('run-1')
		expect(projected[0].ts).toBe(12345)
		expect(projected[0].payload).toEqual({
			toolName: 'search'
		})
	})

	test('handles mixed event sequence correctly', () => {
		const events = [
			makeEnvelope({
				kind: 'trace.root',
				seq: 0
			}),
			makeEnvelope({
				kind: 'prompt.snapshot',
				seq: 1
			}),
			makeEnvelope({
				kind: 'model.request',
				seq: 2
			}),
			makeEnvelope({
				kind: 'model.response',
				seq: 3
			}),
			makeEnvelope({
				kind: 'tool.start',
				seq: 4
			}),
			makeEnvelope({ kind: 'tool.end', seq: 5 })
		]
		const projected = projectTraceToEvents(events)
		expect(projected).toHaveLength(2)
		expect(projected[0].type).toBe('assistant_message')
		expect(projected[1].type).toBe('tool_execution')
	})

	test('returns empty array for empty input', () => {
		const projected = projectTraceToEvents([])
		expect(projected).toEqual([])
	})
})
