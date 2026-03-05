/**
 * memory_append_daily — append-only tool for agent-authored daily memory.
 *
 * The agent calls this tool to persist durable facts into a daily markdown
 * file at `memory/YYYY-MM-DD.md` inside the workspace directory. Entries
 * are timestamped and always appended — the file is never truncated.
 *
 * The tool auto-resolves today's date for the filename and ensures the
 * `memory/` subdirectory exists.
 */

import * as v from 'valibot'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import { join } from 'node:path'
import {
	mkdirSync,
	existsSync,
	readFileSync,
	appendFileSync
} from 'node:fs'

// ── Schema ──────────────────────────────────────────────────────────────

const params = v.object({
	entries: v.pipe(
		v.array(v.string()),
		v.minLength(1),
		v.description(
			'One or more memory entries to append. Each entry is a short durable fact, preference, decision, or commitment.'
		)
	)
})

type Params = v.InferOutput<typeof params>

// ── Factory ─────────────────────────────────────────────────────────────

export function createMemoryAppendDailyTool(
	workspaceDir: string
): AgentTool {
	const memoryDir = join(workspaceDir, 'memory')

	return {
		name: 'memory_append_daily',
		description:
			"Append one or more memory entries to today's daily memory file (memory/YYYY-MM-DD.md). " +
			'Use this to persist durable facts: user preferences, decisions, plans, commitments, ' +
			'deadlines, or TODOs that should survive across sessions. Entries are timestamped ' +
			'and always appended — the file is never overwritten. ' +
			'Call this BEFORE your final answer whenever a MUST-WRITE trigger is met.',
		label: 'Writing daily memory',
		parameters: params,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const { entries } = rawParams as Params

			try {
				// Ensure memory/ directory exists
				mkdirSync(memoryDir, { recursive: true })

				const today = todayDateString()
				const filePath = join(memoryDir, `${today}.md`)

				// Build append block
				const timestamp = new Date()
					.toISOString()
					.slice(11, 19)
				const lines = entries
					.map(e => `- [${timestamp}] ${e}`)
					.join('\n')

				// If file doesn't exist, create with header
				const needsHeader = !existsSync(filePath)
				const block = needsHeader
					? `# ${today}\n\n${lines}\n`
					: `\n${lines}\n`

				appendFileSync(filePath, block, 'utf-8')

				// Verify write
				const written = readFileSync(filePath, 'utf-8')
				const entryCount = entries.length

				return {
					content: [
						{
							type: 'text',
							text: `Appended ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} to memory/${today}.md`
						}
					],
					details: {
						file: `memory/${today}.md`,
						entriesWritten: entryCount,
						totalFileLength: written.length
					}
				}
			} catch (err) {
				return {
					content: [
						{
							type: 'text',
							text: `Failed to write daily memory: ${err instanceof Error ? err.message : String(err)}`
						}
					],
					details: { written: false }
				}
			}
		}
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────

function todayDateString(): string {
	const now = new Date()
	const y = now.getFullYear()
	const m = String(now.getMonth() + 1).padStart(2, '0')
	const d = String(now.getDate()).padStart(2, '0')
	return `${y}-${m}-${d}`
}
