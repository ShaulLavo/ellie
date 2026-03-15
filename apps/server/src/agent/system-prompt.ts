import { readWorkspaceFile } from './workspace'

const PROMPT_SECTIONS = [
	'SOUL.md',
	'IDENTITY.md',
	'USER.md',
	'AGENTS.md',
	'TOOLS.md',
	'HEARTBEAT.md'
] as const

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
