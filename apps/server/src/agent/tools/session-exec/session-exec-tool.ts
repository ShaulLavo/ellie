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
 *   When baseTools are provided, they are bridged into the REPL
 *   subprocess via IPC — callable as async functions by name
 *   (same as script_exec).
 */

import * as v from 'valibot'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import {
	ReplRuntime,
	type ReplEvalResult,
	type ReplToolConfig
} from '../../repl/repl-runtime'
import { ArtifactStore } from '../../repl/artifact-store'
import { createAgentToolBridge } from '../script-exec/bridge'

// ── Schema ──────────────────────────────────────────────────────────────

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

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create the session_exec tool with a persistent REPL session.
 *
 * The REPL process is lazily started on first invocation and kept
 * alive for the duration of the session. State persists between
 * consecutive calls.
 *
 * When baseTools are provided, they are bridged into the REPL via
 * IPC — the child process can call them as async functions.
 */
export function createSessionExecTool(
	dataDir: string,
	getSessionId: () => string | null,
	baseTools?: AgentTool[]
): AgentTool {
	let runtime: ReplRuntime | null = null
	let boundSessionId: string | null = null
	const artifactStore = new ArtifactStore(dataDir)

	// Build IPC tool bridge once (if tools provided)
	let toolConfig: ReplToolConfig | undefined
	if (baseTools && baseTools.length > 0) {
		const bridge = createAgentToolBridge(baseTools)
		toolConfig = {
			tools: bridge.tools,
			client: bridge.client
		}
	}

	return {
		name: 'session_exec',
		description:
			'Execute TypeScript code in a persistent REPL session. Variables, imports, and function definitions persist across calls. Tools are available as async functions: read_workspace_file({ path }), write_workspace_file({ path, content }), shell({ command }), ripgrep({ pattern }). Use print() to send output to the conversation — only printed output appears in tool results. Raw stdout/stderr is stored as artifacts for later inspection. Example: `const f = await read_workspace_file({ path: "data.json" }); print(f)`',
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
					runtime = new ReplRuntime(
						currentSessionId ?? undefined,
						toolConfig
					)
					await runtime.start()
					boundSessionId = currentSessionId
				}

				const result: ReplEvalResult =
					await runtime.evaluate(
						params.code,
						params.timeoutMs
					)

				// Always log the full execution trace
				await artifactStore.append(runtime.sessionId, {
					code: params.code,
					committed: result.committed,
					raw: result.raw,
					isError: result.isError,
					errorMessage: result.errorMessage,
					elapsedMs: result.elapsedMs
				})

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
