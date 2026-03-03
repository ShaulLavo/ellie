/**
 * PTC tool — execute TypeScript scripts in an isolated sandbox.
 *
 * Gives the agent the ability to write and run multi-step code that
 * chains tool calls, uses loops/conditionals, and produces a final
 * result via console.log().
 */

import * as v from 'valibot'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import { ExecutionError } from '@ellie/code-exec'
import { executeFromAgentTools } from './bridge'

// ── Schema ──────────────────────────────────────────────────────────────

const ptcParams = v.object({
	script: v.pipe(
		v.string(),
		v.description(
			'TypeScript code to execute. Use console.log() to output the final result. Available tools are callable as async functions by name.'
		)
	),
	timeoutMs: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Max execution time in milliseconds (default: 30000)'
			)
		)
	),
	maxToolCalls: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Max number of tool calls allowed (default: 64)'
			)
		)
	),
	maxOutputBytes: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Max output size in bytes (default: 262144)'
			)
		)
	)
})

type PtcParams = v.InferOutput<typeof ptcParams>

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create the PTC tool bound to a set of base tools.
 *
 * The base tools are bridged into the sandbox — the child process
 * can call them as async functions. `run_ptc_script` itself is NOT
 * included in the base tools, preventing recursive self-invocation.
 */
export function createPtcTool(
	baseTools: AgentTool[]
): AgentTool {
	return {
		name: 'run_ptc_script',
		description:
			'Run TypeScript code in a sandboxed process with access to your other tools. Use this for multi-step workflows that need loops, conditionals, or chaining multiple tool calls. Each tool is available as an async function (e.g. `await read_workspace_file({ path: "MEMORY.md" })`). Use console.log() to output the final result.',
		label: 'Running script',
		parameters: ptcParams,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as PtcParams

			const opts = {
				...(params.timeoutMs !== undefined && {
					timeoutMs: params.timeoutMs
				}),
				...(params.maxToolCalls !== undefined && {
					maxToolCalls: params.maxToolCalls
				}),
				...(params.maxOutputBytes !== undefined && {
					maxOutputBytes: params.maxOutputBytes
				})
			}

			try {
				const output = await executeFromAgentTools(
					params.script,
					baseTools,
					Object.keys(opts).length > 0 ? opts : undefined
				)

				return {
					content: [
						{
							type: 'text',
							text: output || '(no output)'
						}
					],
					details: { success: true }
				}
			} catch (err) {
				if (err instanceof ExecutionError) {
					return {
						content: [
							{
								type: 'text',
								text: `Script error [${err.code}]: ${err.message}${err.stderrSnippet ? `\n\nstderr:\n${err.stderrSnippet}` : ''}`
							}
						],
						details: {
							success: false,
							code: err.code,
							exitCode: err.exitCode
						}
					}
				}

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
			}
		}
	}
}
