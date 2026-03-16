import { readWorkspaceFile } from '@ellie/agent/workspace'

const PROMPT_SECTIONS = [
	'SOUL.md',
	'IDENTITY.md',
	'USER.md',
	'AGENTS.md',
	'TOOLS.md',
	'HEARTBEAT.md'
] as const

/**
 * Build the base system prompt from workspace files.
 * Does NOT include skills — skill selection goes through
 * the definition's selectSkills path.
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
