import { readFileSync } from 'node:fs'
import { stripFrontmatter } from './frontmatter'
import type { Skill } from './types'

const SKILL_CMD_RE =
	/^\/skill:([a-z][a-z0-9-]*)\s*([\s\S]*)$/

export function expandSkillCommand(
	text: string,
	skills: Skill[]
): string {
	const match = text.match(SKILL_CMD_RE)
	if (!match) return text

	const name = match[1]
	const args = match[2].trim()

	const skill = skills.find(s => s.name === name)
	if (!skill) return text

	let content: string
	try {
		content = readFileSync(skill.filePath, 'utf-8')
	} catch {
		return text
	}

	const body = stripFrontmatter(content)
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\n${body}\n</skill>`

	return args ? `${block}\n\n${args}` : block
}
