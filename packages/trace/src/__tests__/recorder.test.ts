import {
	describe,
	test,
	expect,
	beforeEach
} from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TraceRecorder } from '../recorder'
import { createRootScope, createChildScope } from '../scope'

describe('TraceRecorder', () => {
	let traceDir: string
	let recorder: TraceRecorder

	beforeEach(() => {
		traceDir = mkdtempSync(join(tmpdir(), 'trace-test-'))
		recorder = new TraceRecorder(traceDir)
	})

	test('record writes JSONL and readTrace returns events', () => {
		const scope = createRootScope({
			sessionId: 's1',
			runId: 'r1'
		})

		recorder.record(scope, 'test.event', 'test', {
			key: 'value'
		})

		const events = recorder.readTrace(scope.traceId)
		expect(events).toHaveLength(1)
		expect(events[0].kind).toBe('test.event')
		expect(events[0].component).toBe('test')
		expect(events[0].traceId).toBe(scope.traceId)
		expect(events[0].spanId).toBe(scope.spanId)
		expect(events[0].sessionId).toBe('s1')
		expect(events[0].runId).toBe('r1')
		expect(events[0].payload).toEqual({
			key: 'value'
		})
	})

	test('monotonic seq within a trace', () => {
		const scope = createRootScope()

		recorder.record(scope, 'a', 'test', {})
		recorder.record(scope, 'b', 'test', {})
		recorder.record(scope, 'c', 'test', {})

		const events = recorder.readTrace(scope.traceId)
		expect(events).toHaveLength(3)
		expect(events[0].seq).toBe(0)
		expect(events[1].seq).toBe(1)
		expect(events[2].seq).toBe(2)
	})

	test('independent seq counters per trace', () => {
		const scope1 = createRootScope()
		const scope2 = createRootScope()

		recorder.record(scope1, 'a', 'test', {})
		recorder.record(scope2, 'x', 'test', {})
		recorder.record(scope1, 'b', 'test', {})

		const events1 = recorder.readTrace(scope1.traceId)
		const events2 = recorder.readTrace(scope2.traceId)

		expect(events1[0].seq).toBe(0)
		expect(events1[1].seq).toBe(1)
		expect(events2[0].seq).toBe(0)
	})

	test('child span events appear in same trace', () => {
		const root = createRootScope()
		const child = createChildScope(root)

		recorder.record(root, 'root.event', 'test', {})
		recorder.record(child, 'child.event', 'test', {})

		const events = recorder.readTrace(root.traceId)
		expect(events).toHaveLength(2)
		expect(events[0].parentSpanId).toBeUndefined()
		expect(events[1].parentSpanId).toBe(root.spanId)
	})

	test('blobRefs are included in envelope', () => {
		const scope = createRootScope()

		recorder.record(scope, 'test', 'test', {}, [
			{
				uploadId: 'up-1',
				storagePath: 'trace/x/y/z.txt',
				mimeType: 'text/plain',
				sizeBytes: 100,
				ohash: 'abc123',
				role: 'test_role'
			}
		])

		const events = recorder.readTrace(scope.traceId)
		expect(events[0].blobRefs).toHaveLength(1)
		expect(events[0].blobRefs![0].uploadId).toBe('up-1')
	})

	test('listTraceIds returns available trace IDs', () => {
		const scope1 = createRootScope()
		const scope2 = createRootScope()

		recorder.record(scope1, 'a', 'test', {})
		recorder.record(scope2, 'b', 'test', {})

		const ids = recorder.listTraceIds()
		expect(ids).toContain(scope1.traceId)
		expect(ids).toContain(scope2.traceId)
	})

	test('findTracesBySession filters by sessionId', () => {
		const scope1 = createRootScope({ sessionId: 's1' })
		const scope2 = createRootScope({ sessionId: 's2' })
		const scope3 = createRootScope({ sessionId: 's1' })

		recorder.record(scope1, 'a', 'test', {})
		recorder.record(scope2, 'b', 'test', {})
		recorder.record(scope3, 'c', 'test', {})

		const s1Traces = recorder.findTracesBySession('s1')
		expect(s1Traces).toHaveLength(2)
		expect(s1Traces.map(e => e.traceId)).toContain(
			scope1.traceId
		)
		expect(s1Traces.map(e => e.traceId)).toContain(
			scope3.traceId
		)
	})

	test('readTrace returns empty array for unknown trace', () => {
		const events = recorder.readTrace('nonexistent')
		expect(events).toEqual([])
	})

	test('envelope has required fields', () => {
		const scope = createRootScope()
		recorder.record(scope, 'test', 'comp', {
			data: true
		})

		const [event] = recorder.readTrace(scope.traceId)
		expect(event.eventId).toBeTruthy()
		expect(event.traceId).toBe(scope.traceId)
		expect(event.spanId).toBe(scope.spanId)
		expect(event.kind).toBe('test')
		expect(event.component).toBe('comp')
		expect(event.ts).toBeGreaterThan(0)
		expect(event.seq).toBe(0)
		expect(event.payload).toEqual({ data: true })
	})
})
