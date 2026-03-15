import { readWorkspaceFile } from './workspace'
import { loadSkills } from './skills/discovery'
import { formatSkillsForPrompt } from './skills/prompt'
import type { Skill } from './skills/types'

const PROMPT_SECTIONS = [
	'SOUL.md',
	'IDENTITY.md',
	'USER.md',
	'AGENTS.md',
	'TOOLS.md',
	'HEARTBEAT.md'
] as const

export function buildSystemPrompt(workspaceDir: string): {
	prompt: string
	skills: Skill[]
} {
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

	const { skills, diagnostics } = loadSkills()

	for (const d of diagnostics) {
		console.warn(
			`[skills] ${d.type}: ${d.message} (${d.path})`
		)
	}

	if (skills.length > 0) {
		console.log(`[skills] loaded ${skills.length} skill(s)`)
	}

	const skillsBlock = formatSkillsForPrompt(skills)
	if (skillsBlock) {
		sections.push(skillsBlock)
	}

	return {
		prompt: sections.join('\n\n---\n\n'),
		skills
	}
}
