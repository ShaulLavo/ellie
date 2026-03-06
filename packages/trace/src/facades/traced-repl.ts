/**
 * Traced REPL facade — wraps exec / session_exec tool execution
 * to emit repl.start / repl.end trace events.
 *
 * Uses structural typing to avoid importing @ellie/agent types.
 */

import { createChildScope } from '../scope'
import { shouldBlob } from '../blob-sink'
import type {
	BlobRef,
	BlobSink,
	TraceScope
} from '../types'
import type { TraceRecorder } from '../recorder'

// Structural types matching AgentTool

interface ToolResult {
	content: Array<{ type: string; text?: string }>
	details: unknown
}

interface ReplTool {
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

export interface TracedReplOptions {
	recorder: TraceRecorder
	blobSink?: BlobSink
	getParentScope: () => TraceScope | undefined
}

/** Structural interface for tools that support scope threading. */
interface ScopeSettable {
	setActiveReplScope?: (
		scope: TraceScope | undefined
	) => void
}

const REPL_TOOL_NAMES = new Set(['exec', 'session_exec'])

/**
 * Wrap a REPL tool (exec or session_exec) to emit repl.start/repl.end
 * trace events. Non-REPL tools are returned unchanged.
 */
export function createTracedReplTool<T extends ReplTool>(
	tool: T,
	opts: TracedReplOptions
): T {
	if (!REPL_TOOL_NAMES.has(tool.name)) return tool

	const wrappedExecute: ReplTool['execute'] = async (
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

		// Thread scope so REPL HTTP handler nests tool calls under this span
		const settable = tool as ReplTool & ScopeSettable
		if (settable.setActiveReplScope) {
			settable.setActiveReplScope(scope)
		}

		const code = (params as Record<string, unknown>)?.code
		opts.recorder.record(scope, 'repl.start', 'repl', {
			toolName: tool.name,
			toolCallId,
			codePreview:
				typeof code === 'string'
					? code.slice(0, 500)
					: undefined
		})

		try {
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
				opts.recorder.record(scope, 'repl.end', 'repl', {
					toolName: tool.name,
					toolCallId,
					isError: true,
					error:
						err instanceof Error
							? err.message
							: String(err),
					elapsedMs: Date.now() - startedAt
				})
				throw err
			}

			const elapsedMs = Date.now() - startedAt
			const outputText = result.content
				.filter(c => c.type === 'text')
				.map(c => c.text ?? '')
				.join('\n')

			let blobRefs: BlobRef[] | undefined
			const shouldWriteBlob =
				opts.blobSink && shouldBlob(outputText)
			if (shouldWriteBlob) {
				try {
					const ref = await opts.blobSink!.write({
						traceId: scope.traceId,
						spanId: scope.spanId,
						role: 'repl_output',
						content: outputText,
						mimeType: 'text/plain',
						ext: 'txt'
					})
					blobRefs = [ref]
				} catch (blobErr) {
					console.warn(
						`[traced-repl] output blob write failed (traceId=${scope.traceId}):`,
						blobErr instanceof Error
							? blobErr.message
							: String(blobErr)
					)
				}
			}
			const hasBlob = (blobRefs?.length ?? 0) > 0

			opts.recorder.record(
				scope,
				'repl.end',
				'repl',
				{
					toolName: tool.name,
					toolCallId,
					isError,
					elapsedMs,
					// Full output inline unless the blob write succeeded
					...(hasBlob
						? {
								outputPreview: outputText.slice(0, 500),
								outputLength: outputText.length
							}
						: { output: outputText }),
					details: result.details
				},
				blobRefs
			)

			return result
		} finally {
			if (settable.setActiveReplScope) {
				settable.setActiveReplScope(undefined)
			}
		}
	}

	return {
		...tool,
		execute: wrappedExecute
	} as T
}
