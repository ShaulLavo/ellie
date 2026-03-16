/**
 * Ripgrep tool — search file contents using ripgrep.
 *
 * Gives the agent the ability to search through files for patterns
 * using `rg` (ripgrep), returning matching lines with context.
 */

import * as v from 'valibot'
import type { AgentTool, AgentToolResult } from '../types'

const ripgrepParams = v.object({
	pattern: v.pipe(
		v.string(),
		v.description(
			'The regex pattern to search for in file contents'
		)
	),
	path: v.optional(
		v.pipe(
			v.string(),
			v.description(
				'File or directory to search in (defaults to workspace directory)'
			)
		)
	),
	glob: v.optional(
		v.pipe(
			v.string(),
			v.description(
				'Glob pattern to filter files (e.g. "*.ts", "*.{js,jsx}")'
			)
		)
	),
	caseInsensitive: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Case insensitive search (default: false)'
			)
		)
	),
	contextLines: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Number of context lines to show before and after each match (default: 0)'
			)
		)
	),
	maxResults: v.optional(
		v.pipe(
			v.number(),
			v.description(
				'Maximum number of matching lines to return (default: 100)'
			)
		)
	)
})

type RipgrepParams = v.InferOutput<typeof ripgrepParams>

const DEFAULT_MAX_RESULTS = 100
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_OUTPUT_CHARS = 50_000

/**
 * Create the ripgrep tool with a default search path.
 */
export function createRipgrepTool(
	defaultPath: string
): AgentTool {
	return {
		name: 'ripgrep',
		description:
			'Search file contents using ripgrep (rg). Supports regex patterns, glob filtering, context lines, and case-insensitive search. Returns matching lines with file paths and line numbers.',
		label: 'Searching files',
		parameters: ripgrepParams,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as RipgrepParams
			const searchPath = params.path ?? defaultPath
			const maxResults =
				params.maxResults ?? DEFAULT_MAX_RESULTS

			const args = [
				'rg',
				'--line-number',
				'--no-heading',
				'--color=never',
				`--max-count=${maxResults}`
			]

			if (params.caseInsensitive) args.push('--ignore-case')
			if (params.glob) args.push('--glob', params.glob)
			if (params.contextLines !== undefined)
				args.push(`--context=${params.contextLines}`)

			args.push('--', params.pattern, searchPath)

			try {
				const proc = Bun.spawn(args, {
					stdout: 'pipe',
					stderr: 'pipe'
				})

				let timeoutId:
					| ReturnType<typeof setTimeout>
					| undefined
				const timeoutPromise = new Promise<never>(
					(_, reject) => {
						timeoutId = setTimeout(() => {
							proc.kill()
							reject(
								new Error(
									`Ripgrep timed out after ${DEFAULT_TIMEOUT_MS}ms`
								)
							)
						}, DEFAULT_TIMEOUT_MS)
					}
				)

				let exitCode: number
				try {
					exitCode = await Promise.race([
						proc.exited,
						timeoutPromise
					])
				} finally {
					clearTimeout(timeoutId)
				}

				const stdout = await new Response(
					proc.stdout
				).text()
				const stderr = await new Response(
					proc.stderr
				).text()

				// rg exit codes: 0 = matches found, 1 = no matches, 2 = error
				if (exitCode === 1) {
					return {
						content: [
							{
								type: 'text',
								text: `No matches found for pattern "${params.pattern}" in ${searchPath}`
							}
						],
						details: {
							matchCount: 0,
							searchPath
						}
					}
				}

				if (exitCode === 2 || (!stdout && stderr)) {
					return {
						content: [
							{
								type: 'text',
								text: `Ripgrep error: ${stderr || 'unknown error'}`
							}
						],
						details: {
							exitCode,
							searchPath,
							error: stderr
						}
					}
				}

				const truncated =
					stdout.length > MAX_OUTPUT_CHARS
						? stdout.slice(0, MAX_OUTPUT_CHARS) +
							`\n... (truncated at ${MAX_OUTPUT_CHARS} chars)`
						: stdout

				const matchCount = stdout
					.split('\n')
					.filter(l => l.length > 0).length

				return {
					content: [
						{
							type: 'text',
							text: truncated || '(no output)'
						}
					],
					details: { matchCount, searchPath, exitCode }
				}
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : String(err)
				return {
					content: [
						{
							type: 'text',
							text: `Ripgrep error: ${msg}`
						}
					],
					details: { success: false, error: msg }
				}
			}
		}
	}
}
