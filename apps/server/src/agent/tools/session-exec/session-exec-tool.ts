/**
 * session_exec tool — execute code in a persistent REPL session.
 *
 * Persistent session execution. Variables, imports, and function
 * definitions survive across consecutive calls within the same
 * session process.
 *
 * Context contract:
 *   - Only output from print() enters the model context.
 *   - Raw stdout/stderr is stored as artifacts, NOT injected into
 *     the conversation transcript.
 *   - This prevents context bloat from verbose execution output.
 *
 * Tool access:
 *   When baseTools are provided, they are exposed in the REPL
 *   via a localhost HTTP server — callable as async functions
 *   by name (e.g. `await shell({ command: "ls" })`).
 */

import * as v from 'valibot'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import type {
	BlobRef,
	BlobSink,
	TraceRecorder,
	TraceScope
} from '@ellie/trace'
import { shouldBlob } from '@ellie/trace'
import {
	ReplRuntime,
	type ReplEvalResult
} from '../../repl/repl-runtime'
import { createReplTraceDeps } from './repl-trace-deps'

const sessionExecParams = v.object({
	code: v.pipe(
		v.string(),
		v.description(
			'TypeScript code to execute in the persistent REPL session. Variables, imports, and functions persist across calls. Tools (read_workspace_file, write_workspace_file, shell, ripgrep) are available as async functions. Use print() to send output to the conversation — raw console.log() output is stored as artifacts but does NOT appear in conversation context.'
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

type SessionExecParams = v.InferOutput<
	typeof sessionExecParams
>

/**
 * Create the session_exec tool with a persistent REPL session.
 *
 * The REPL process is lazily started on first invocation and kept
 * alive for the duration of the session. State persists between
 * consecutive calls.
 *
 * When baseTools are provided, they are exposed in the REPL
 * subprocess via a localhost HTTP server.
 */
export function createSessionExecTool(
	getBranchId: () => string | null,
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
	let runtime: ReplRuntime | null = null
	let boundBranchId: string | null = null

	return {
		name: 'session_exec',
		description:
			'Execute TypeScript code in a persistent REPL session. Variables, imports, and function definitions persist across calls. Tools are available as async functions: read_workspace_file({ path }), write_workspace_file({ path, content }), shell({ command }), ripgrep({ pattern }). Use print() to send output to the conversation — only printed output appears in tool results. Raw stdout/stderr is stored as artifacts for later inspection. Example: `const f = await read_workspace_file({ path: "data.json" }); print(f)`',
		label: 'Running session code',
		parameters: sessionExecParams,
		setActiveReplScope,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as SessionExecParams

			try {
				const currentBranchId = getBranchId()

				// Tear down REPL if the agent rebound to a different branch
				if (
					runtime &&
					boundBranchId !== null &&
					currentBranchId !== boundBranchId
				) {
					await runtime.teardown()
					runtime = null
				}

				// Lazy-start the REPL on first call (or after teardown/timeout)
				if (!runtime || !runtime.alive) {
					runtime = new ReplRuntime(
						currentBranchId ?? undefined,
						baseTools,
						replTraceDeps
					)
					await runtime.start()
					boundBranchId = currentBranchId
				}

				const result: ReplEvalResult =
					await runtime.evaluate(
						params.code,
						params.timeoutMs
					)

				// Persist execution trace through blob sink + trace recorder
				if (replTraceDeps) {
					const scope = replTraceDeps.getParentScope()
					if (scope) {
						const artifact = {
							code: params.code,
							committed: result.committed,
							raw: result.raw,
							isError: result.isError,
							errorMessage: result.errorMessage,
							elapsedMs: result.elapsedMs
						}
						const serialized = JSON.stringify(artifact)

						let blobRefs: BlobRef[] | undefined
						const shouldWriteBlob =
							replTraceDeps.blobSink &&
							shouldBlob(serialized)
						if (shouldWriteBlob) {
							try {
								const ref =
									await replTraceDeps.blobSink!.write({
										traceId: scope.traceId,
										spanId: scope.spanId,
										role: 'repl_artifact',
										content: serialized,
										mimeType: 'application/json',
										ext: 'json'
									})
								blobRefs = [ref]
							} catch (blobErr) {
								console.warn(
									'[session_exec] artifact blob write failed:',
									blobErr instanceof Error
										? blobErr.message
										: String(blobErr)
								)
							}
						}
						const hasBlob = (blobRefs?.length ?? 0) > 0

						replTraceDeps.recorder.record(
							scope,
							'repl.artifact',
							'repl',
							{
								sessionId: runtime.sessionId,
								isError: result.isError,
								elapsedMs: result.elapsedMs,
								// Full artifact inline unless the blob write succeeded
								...(hasBlob
									? {
											codePreview: params.code.slice(
												0,
												500
											),
											committedLength:
												result.committed.length,
											rawLength: result.raw.length
										}
									: {
											code: params.code,
											committed: result.committed,
											raw: result.raw,
											errorMessage: result.errorMessage
										})
							},
							blobRefs
						)
					}
				}

				// Only committed output goes into tool result
				if (result.isError) {
					return {
						content: [
							{
								type: 'text',
								text: result.errorMessage
									? `Session error: ${result.errorMessage}`
									: 'Session execution failed'
							}
						],
						details: {
							success: false,
							sessionId: runtime.sessionId,
							elapsedMs: result.elapsedMs,
							hasArtifacts: !!result.raw
						}
					}
				}

				const outputText =
					result.committed ||
					'(no committed output — use print() to send output to conversation)'

				return {
					content: [
						{
							type: 'text',
							text: outputText
						}
					],
					details: {
						success: true,
						sessionId: runtime.sessionId,
						elapsedMs: result.elapsedMs,
						hasArtifacts: !!result.raw
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
					details: {
						success: false,
						sessionId: runtime?.sessionId ?? null
					}
				}
			}
		}
	}
}
