/**
 * Trace scope factories — create root and child scopes.
 *
 * Scope propagation is explicit via function parameters.
 */

import { ulid } from 'fast-ulid'
import type { TraceKind, TraceScope } from './types'

/**
 * Create a root trace scope. This is the entry point for a new trace.
 */
export function createRootScope(opts: {
	traceKind: TraceKind
	branchId?: string
	runId?: string
}): TraceScope {
	const id = ulid()
	return {
		traceId: id,
		spanId: id, // root span shares the trace ID
		parentSpanId: undefined,
		branchId: opts.branchId,
		runId: opts.runId,
		traceKind: opts.traceKind
	}
}

/**
 * Create a child scope from a parent. Inherits traceId, branchId, runId, traceKind.
 * Gets a fresh spanId and sets parentSpanId to the parent's spanId.
 */
export function createChildScope(
	parent: TraceScope
): TraceScope {
	return {
		traceId: parent.traceId,
		spanId: ulid(),
		parentSpanId: parent.spanId,
		branchId: parent.branchId,
		runId: parent.runId,
		traceKind: parent.traceKind
	}
}
