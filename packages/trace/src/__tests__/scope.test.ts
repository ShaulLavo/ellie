import { describe, test, expect } from 'bun:test'
import { createRootScope, createChildScope } from '../scope'

describe('createRootScope', () => {
	test('root span shares traceId as spanId', () => {
		const scope = createRootScope()
		expect(scope.traceId).toBeTruthy()
		expect(scope.spanId).toBe(scope.traceId)
	})

	test('includes optional sessionId and runId', () => {
		const scope = createRootScope({
			sessionId: 'sess-1',
			runId: 'run-1'
		})
		expect(scope.sessionId).toBe('sess-1')
		expect(scope.runId).toBe('run-1')
		expect(scope.parentSpanId).toBeUndefined()
	})

	test('root scope has no parentSpanId', () => {
		const scope = createRootScope()
		expect(scope.parentSpanId).toBeUndefined()
	})
})

describe('createChildScope', () => {
	test('inherits traceId, sessionId, runId from parent', () => {
		const parent = createRootScope({
			sessionId: 'sess-1',
			runId: 'run-1'
		})
		const child = createChildScope(parent)

		expect(child.traceId).toBe(parent.traceId)
		expect(child.sessionId).toBe('sess-1')
		expect(child.runId).toBe('run-1')
	})

	test('has unique spanId different from parent', () => {
		const parent = createRootScope()
		const child = createChildScope(parent)

		expect(child.spanId).toBeTruthy()
		expect(child.spanId).not.toBe(parent.spanId)
	})

	test('parentSpanId points to parent spanId', () => {
		const parent = createRootScope()
		const child = createChildScope(parent)

		expect(child.parentSpanId).toBe(parent.spanId)
	})

	test('grandchild chain works correctly', () => {
		const root = createRootScope()
		const child = createChildScope(root)
		const grandchild = createChildScope(child)

		expect(grandchild.traceId).toBe(root.traceId)
		expect(grandchild.parentSpanId).toBe(child.spanId)
		expect(grandchild.spanId).not.toBe(child.spanId)
	})
})
