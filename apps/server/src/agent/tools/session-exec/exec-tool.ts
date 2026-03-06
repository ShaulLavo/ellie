/**
 * exec tool — one-shot TypeScript execution.
 *
 * Spins up a fresh REPL, evaluates the code, tears it down.
 * No state persists between calls — every invocation is isolated.
 *
 * Same tool access as session_exec (shell, ripgrep, file I/O)
 * but ephemeral. Use for bounded scripts that don't need state.
 */

import * as v from 'valibot'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import type {
	BlobSink,
	TraceRecorder,
	TraceScope
} from '@ellie/trace'
import { ReplRuntime } from '../../repl/repl-runtime'
import { createReplTraceDeps } from './repl-trace-deps'

// ── Schema ──────────────────────────────────────────────────────────────

const execParams = v.object({
	code: v.pipe(
		v.string(),
		v.description(
			'TypeScript code to execute in a fresh isolated environment. Tools (read_workspace_file, write_workspace_file, shell, ripgrep) are available as async functions. Use print() to return output. No state persists between calls.'
		)
	),
	timeoutMs: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Max execution time in milliseconds (default: 30000)'
			)
		)
	)
})

type ExecParams = v.InferOutput<typeof execParams>

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create the exec tool — one-shot isolated code execution.
 *
 * Each call spawns a fresh REPL, runs the code, and tears down.
 */
export function createExecTool(
	baseTools?: AgentTool[],
	traceDeps?: {
		recorder: TraceRecorder
		blobSink?: BlobSink
	}
): AgentTool & {
	setActiveReplScope?: (
		scope: TraceScope | undefined
	) => void
} {
	const { replTraceDeps, setActiveReplScope } =
		createReplTraceDeps(traceDeps)

	return {
		name: 'exec',
		description:
			'Execute TypeScript in a fresh isolated environment. No state persists between calls. Tools are available as async functions: read_workspace_file({ path }), write_workspace_file({ path, content }), shell({ command }), ripgrep({ pattern }). Use print() to return output. Example: `const files = await shell({ command: "ls" }); print(files)`',
		label: 'Running code',
		parameters: execParams,
		setActiveReplScope,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as ExecParams
			const runtime = new ReplRuntime(
				undefined,
				baseTools,
				replTraceDeps
			)

			try {
				await runtime.start()

				const result = await runtime.evaluate(
					params.code,
					params.timeoutMs
				)

				if (result.isError) {
					return {
						content: [
							{
								type: 'text',
								text: result.errorMessage
									? `Error: ${result.errorMessage}`
									: 'Execution failed'
							}
						],
						details: {
							success: false,
							elapsedMs: result.elapsedMs
						}
					}
				}

				return {
					content: [
						{
							type: 'text',
							text:
								result.committed ||
								'(no output — use print() to return output)'
						}
					],
					details: {
						success: true,
						elapsedMs: result.elapsedMs
					}
				}
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : String(err)
				return {
					content: [
						{
							type: 'text',
							text: `Unexpected error: ${msg}`
						}
					],
					details: { success: false }
				}
			} finally {
				await runtime.teardown()
			}
		}
	}
}
