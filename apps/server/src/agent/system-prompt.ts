/**
 * System prompt — assembles the system prompt from workspace files.
 *
 * Reads workspace files in a fixed order and concatenates them
 * into a single system prompt string. BOOTSTRAP.md is excluded
 * from the steady-state prompt (it's delivered via synthetic
 * tool-read in the history instead).
 */

import { readWorkspaceFile } from './workspace'

/** Ordered sections for the system prompt (BOOTSTRAP excluded) */
const PROMPT_SECTIONS = [
	'SOUL.md',
	'IDENTITY.md',
	'USER.md',
	'AGENTS.md',
	'TOOLS.md',
	'HEARTBEAT.md',
	'MEMORY.md'
] as const

/**
 * Build the system prompt from workspace files.
 * Sections that don't exist or are empty are silently skipped.
 */
export function buildSystemPrompt(
	workspaceDir: string
): string {
	const sections: string[] = []

	for (const filename of PROMPT_SECTIONS) {
		const content = readWorkspaceFile(
			workspaceDir,
			filename
		)
		if (content?.trim()) {
			sections.push(content.trim())
		}
	}

	return sections.join('\n\n---\n\n')
}
