/**
 * Shell tool — execute shell commands.
 *
 * Gives the agent the ability to run arbitrary shell commands and
 * inspect their stdout, stderr, and exit code.
 */

import * as v from 'valibot'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'

const shellParams = v.object({
	command: v.pipe(
		v.string(),
		v.description('The shell command to execute')
	),
	cwd: v.optional(
		v.pipe(
			v.string(),
			v.description(
				'Working directory for the command (defaults to workspace directory)'
			)
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

type ShellParams = v.InferOutput<typeof shellParams>

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 50_000

/**
 * Create the shell tool with a default working directory.
 */
export function createShellTool(
	defaultCwd: string
): AgentTool {
	return {
		name: 'shell',
		description:
			'Execute a shell command and return its output. Use this to run system commands, inspect files, manage processes, or perform any terminal operation.',
		label: 'Running shell command',
		parameters: shellParams,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as ShellParams
			const cwd = params.cwd ?? defaultCwd
			const timeoutMs =
				params.timeoutMs ?? DEFAULT_TIMEOUT_MS

			try {
				const proc = Bun.spawn(
					['sh', '-c', params.command],
					{
						cwd,
						stdout: 'pipe',
						stderr: 'pipe'
					}
				)

				const timeoutPromise = new Promise<never>(
					(_, reject) => {
						setTimeout(() => {
							proc.kill()
							reject(
								new Error(
									`Command timed out after ${timeoutMs}ms`
								)
							)
						}, timeoutMs)
					}
				)

				const exitCode = await Promise.race([
					proc.exited,
					timeoutPromise
				])

				const stdout = await new Response(
					proc.stdout
				).text()
				const stderr = await new Response(
					proc.stderr
				).text()

				const truncate = (s: string) =>
					s.length > MAX_OUTPUT_CHARS
						? s.slice(0, MAX_OUTPUT_CHARS) +
							`\n... (truncated at ${MAX_OUTPUT_CHARS} chars)`
						: s

				const parts: string[] = []
				if (stdout) parts.push(truncate(stdout))
				if (stderr)
					parts.push(`stderr:\n${truncate(stderr)}`)
				if (exitCode !== 0)
					parts.push(`exit code: ${exitCode}`)

				return {
					content: [
						{
							type: 'text',
							text:
								parts.join('\n\n') ||
								'(no output, exit code 0)'
						}
					],
					details: {
						exitCode,
						cwd,
						stdoutLength: stdout.length,
						stderrLength: stderr.length
					}
				}
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : String(err)
				return {
					content: [
						{ type: 'text', text: `Shell error: ${msg}` }
					],
					details: { success: false, error: msg }
				}
			}
		}
	}
}
