/**
 * Traced tool executor facade — wraps an AgentTool so every execution
 * emits tool.start / tool.end trace events.
 *
 * Uses structural typing to avoid importing @ellie/agent types.
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

/**
 * Wrap a single tool so its execute() is bracketed by
 * tool.start and tool.end trace events.
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

		let result: ToolResult
		let isError = false
		try {
			result = await tool.execute(
				toolCallId,
				params,
				signal,
				onUpdate
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
