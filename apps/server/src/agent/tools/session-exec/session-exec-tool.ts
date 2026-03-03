/**
 * session_exec tool — execute code in a persistent REPL session.
 *
 * Persistent session execution. Variables, imports, and function
 * definitions survive across consecutive calls within the same
 * session process.
 *
 * Context contract:
 *   - Only output from print()/commit() enters the model context.
 *   - Raw stdout/stderr is stored as artifacts, NOT injected into
 *     the conversation transcript.
 *   - This prevents context bloat from verbose execution output.
 */

import * as v from 'valibot'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import {
	ReplRuntime,
	type ReplEvalResult
} from '../../repl/repl-runtime'
import { ArtifactStore } from '../../repl/artifact-store'

// ── Schema ──────────────────────────────────────────────────────────────

const sessionExecParams = v.object({
	code: v.pipe(
		v.string(),
		v.description(
			'TypeScript code to execute in the persistent REPL session. Variables, imports, and functions persist across calls. Use print() or commit() to send output to the conversation — raw console.log() output is stored as artifacts but does NOT appear in conversation context.'
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

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create the session_exec tool with a persistent REPL session.
 *
 * The REPL process is lazily started on first invocation and kept
 * alive for the duration of the session. State persists between
 * consecutive calls.
 */
export function createSessionExecTool(
	dataDir: string,
	getSessionId: () => string | null
): AgentTool {
	let runtime: ReplRuntime | null = null
	let boundSessionId: string | null = null
	const artifactStore = new ArtifactStore(dataDir)

	return {
		name: 'session_exec',
		description:
			'Execute TypeScript code in a persistent REPL session. Variables, imports, and function definitions persist across calls. Use print() or commit() to send output to the conversation — only committed output appears in tool results. Raw stdout/stderr is stored as artifacts for later inspection. Use this for iterative workflows where you need to build up state across multiple steps.',
		label: 'Running session code',
		parameters: sessionExecParams,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as SessionExecParams

			try {
				const currentSessionId = getSessionId()

				// Tear down REPL if the agent rebound to a different session
				if (
					runtime &&
					boundSessionId !== null &&
					currentSessionId !== boundSessionId
				) {
					await runtime.teardown()
					runtime = null
				}

				// Lazy-start the REPL on first call (or after teardown)
				if (!runtime || !runtime.alive) {
					runtime = new ReplRuntime()
					await runtime.start()
					boundSessionId = currentSessionId
				}

				const result: ReplEvalResult =
					await runtime.evaluate(
						params.code,
						params.timeoutMs
					)

				// Store raw output as artifact (not injected into context)
				if (result.raw) {
					await artifactStore.append(
						runtime.sessionId,
						params.code,
						result.raw
					)
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
