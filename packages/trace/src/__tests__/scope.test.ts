import { describe, test, expect } from 'bun:test'
import { createRootScope, createChildScope } from '../scope'

describe('createRootScope', () => {
	test('root span shares traceId as spanId', () => {
		const scope = createRootScope({ traceKind: 'chat' })
		expect(scope.traceId).toBeTruthy()
		expect(scope.spanId).toBe(scope.traceId)
	})

	test('includes optional branchId and runId', () => {
		const scope = createRootScope({
			traceKind: 'chat',
			branchId: 'sess-1',
			runId: 'run-1'
		})
		expect(scope.branchId).toBe('sess-1')
		expect(scope.runId).toBe('run-1')
		expect(scope.parentSpanId).toBeUndefined()
	})

	test('root scope has no parentSpanId', () => {
		const scope = createRootScope({ traceKind: 'chat' })
		expect(scope.parentSpanId).toBeUndefined()
	})

	test('traceKind is set on root scope', () => {
		const scope = createRootScope({
			traceKind: 'follow-up'
		})
		expect(scope.traceKind).toBe('follow-up')
	})
})

describe('createChildScope', () => {
	test('inherits traceId, branchId, runId from parent', () => {
		const parent = createRootScope({
			traceKind: 'chat',
			branchId: 'sess-1',
			runId: 'run-1'
		})
		const child = createChildScope(parent)

		expect(child.traceId).toBe(parent.traceId)
		expect(child.branchId).toBe('sess-1')
		expect(child.runId).toBe('run-1')
	})

	test('has unique spanId different from parent', () => {
		const parent = createRootScope({
			traceKind: 'chat'
		})
		const child = createChildScope(parent)

		expect(child.spanId).toBeTruthy()
		expect(child.spanId).not.toBe(parent.spanId)
	})

	test('parentSpanId points to parent spanId', () => {
		const parent = createRootScope({
			traceKind: 'chat'
		})
		const child = createChildScope(parent)

		expect(child.parentSpanId).toBe(parent.spanId)
	})

	test('grandchild chain works correctly', () => {
		const root = createRootScope({
			traceKind: 'chat'
		})
		const child = createChildScope(root)
		const grandchild = createChildScope(child)

		expect(grandchild.traceId).toBe(root.traceId)
		expect(grandchild.parentSpanId).toBe(child.spanId)
		expect(grandchild.spanId).not.toBe(child.spanId)
	})

	test('inherits traceKind from parent', () => {
		const parent = createRootScope({
			traceKind: 'follow-up'
		})
		const child = createChildScope(parent)
		expect(child.traceKind).toBe('follow-up')
	})
})
