import type { Skill } from './types'

function escapeXml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

export function formatSkillsForPrompt(
	skills: Skill[]
): string {
	const visible = skills.filter(
		s => !s.disableModelInvocation
	)
	if (visible.length === 0) return ''

	const entries = visible
		.map(
			s =>
				`  <skill name="${escapeXml(s.name)}" path="${escapeXml(s.filePath)}">\n    ${escapeXml(s.description)}\n  </skill>`
		)
		.join('\n')

	return `<available_skills>\n${entries}\n</available_skills>`
}
