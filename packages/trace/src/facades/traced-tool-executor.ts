/**
 * Traced tool executor facade — wraps an AgentTool so every execution
 * emits tool.start / tool.progress / tool.end trace events.
 *
 * Uses structural typing to avoid importing @ellie/agent types.
 *
 * Progress tracing: when the tool emits updates via onUpdate, the wrapper
 * also records `tool.progress` events in the canonical trace journal.
 * Phase transitions (started/completed/failed) are always recorded.
 * High-frequency updates (e.g. denoising steps) are throttled to avoid
 * flooding the trace with per-step entries.
 */

import { createChildScope } from '../scope'
import type { BlobSink, TraceScope } from '../types'
import type { TraceRecorder } from '../recorder'

// Structural types matching AgentTool / AgentToolResult

interface ToolResult {
	content: Array<{ type: string; text?: string }>
	details: unknown
}

interface TracedTool {
	name: string
	description: string
	parameters: unknown
	label: string
	execute: (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: (partial: ToolResult) => void
	) => Promise<ToolResult>
}

export interface TracedToolOptions {
	recorder: TraceRecorder
	blobSink?: BlobSink
	getParentScope: () => TraceScope | undefined
}

/** Minimum interval between traced progress events for the same phase. */
const PROGRESS_TRACE_THROTTLE_MS = 2_000

/**
 * Wrap a single tool so its execute() is bracketed by
 * tool.start and tool.end trace events, with tool.progress
 * events for intermediate updates.
 */
export function createTracedToolWrapper<
	T extends TracedTool
>(tool: T, opts: TracedToolOptions): T {
	const wrappedExecute: TracedTool['execute'] = async (
		toolCallId,
		params,
		signal,
		onUpdate
	) => {
		const parentScope = opts.getParentScope()
		if (!parentScope) {
			return tool.execute(
				toolCallId,
				params,
				signal,
				onUpdate
			)
		}
		const scope = createChildScope(parentScope)
		const startedAt = Date.now()

		opts.recorder.record(scope, 'tool.start', 'tool', {
			toolName: tool.name,
			toolCallId,
			args: params
		})

		// Wrap onUpdate to also emit tool.progress trace events
		const tracedOnUpdate = onUpdate
			? createTracedOnUpdate(
					onUpdate,
					opts.recorder,
					scope,
					tool.name,
					toolCallId,
					startedAt
				)
			: undefined

		let result: ToolResult
		let isError = false
		try {
			result = await tool.execute(
				toolCallId,
				params,
				signal,
				tracedOnUpdate
			)
		} catch (err) {
			isError = true
			const errorMessage =
				err instanceof Error ? err.message : String(err)
			opts.recorder.record(scope, 'tool.end', 'tool', {
				toolName: tool.name,
				toolCallId,
				isError: true,
				error: errorMessage,
				elapsedMs: Date.now() - startedAt
			})
			throw err
		}

		const elapsedMs = Date.now() - startedAt
		const resultSummary = result.content
			.map(c =>
				c.type === 'text'
					? (c.text?.slice(0, 200) ?? '')
					: `[${c.type}]`
			)
			.join('')

		opts.recorder.record(scope, 'tool.end', 'tool', {
			toolName: tool.name,
			toolCallId,
			isError,
			elapsedMs,
			resultPreview: resultSummary.slice(0, 500),
			hasOverflowRef: !!(
				result.details as Record<string, unknown>
			)?.overflowRef
		})

		return result
	}

	return {
		...tool,
		execute: wrappedExecute
	} as T
}

/**
 * Wrap an onUpdate callback to also emit tool.progress trace events.
 *
 * Phase transitions (started/completed/failed) are always recorded.
 * Running/in-progress updates are throttled per-phase to keep the trace
 * manageable for long-running tools like image generation.
 */
function createTracedOnUpdate(
	originalOnUpdate: (partial: ToolResult) => void,
	recorder: TraceRecorder,
	scope: import('../types').TraceScope,
	toolName: string,
	toolCallId: string,
	startedAt: number
): (partial: ToolResult) => void {
	const lastPhaseUpdate = new Map<string, number>()

	return (partial: ToolResult) => {
		// Always forward to the original callback
		originalOnUpdate(partial)

		// Extract progress details if available
		const details = partial.details as
			| Record<string, unknown>
			| undefined
		if (!details) return

		const phase = details.phase as string | undefined
		const status = details.status as string | undefined
		if (!phase || !status) return

		// Phase transitions are always traced
		const isTransition =
			status === 'started' ||
			status === 'completed' ||
			status === 'failed'

		if (!isTransition) {
			// Throttle running/in-progress updates per phase
			const now = Date.now()
			const lastUpdate = lastPhaseUpdate.get(phase) ?? 0
			if (now - lastUpdate < PROGRESS_TRACE_THROTTLE_MS)
				return
			lastPhaseUpdate.set(phase, now)
		}

		recorder.record(scope, 'tool.progress', 'tool', {
			toolName,
			toolCallId,
			elapsedMs: Date.now() - startedAt,
			phase,
			status,
			detail: details.detail as string | undefined,
			step: details.step as number | undefined,
			totalSteps: details.totalSteps as number | undefined,
			completedPhases: details.completedPhases as
				| string[]
				| undefined
		})
	}
}
