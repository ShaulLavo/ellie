import { describe, test, expect } from 'bun:test'
import { formatSkillsForPrompt } from './prompt'
import type { Skill } from './types'

function makeSkill(overrides?: Partial<Skill>): Skill {
	return {
		name: 'test-skill',
		description: 'A test skill',
		filePath: '/skills/test-skill/SKILL.md',
		baseDir: '/skills',
		source: 'project',
		...overrides
	}
}

describe('formatSkillsForPrompt', () => {
	test('returns empty string for no skills', () => {
		expect(formatSkillsForPrompt([])).toBe('')
	})

	test('returns empty string when all skills are disabled', () => {
		const skills = [
			makeSkill({ disableModelInvocation: true })
		]
		expect(formatSkillsForPrompt(skills)).toBe('')
	})

	test('wraps visible skills in available_skills XML', () => {
		const skills = [makeSkill()]
		const result = formatSkillsForPrompt(skills)
		expect(result).toContain('<available_skills>')
		expect(result).toContain('</available_skills>')
		expect(result).toContain('<skill name="test-skill"')
		expect(result).toContain('A test skill')
	})

	test('filters out disabled skills', () => {
		const skills = [
			makeSkill({ name: 'visible', description: 'yes' }),
			makeSkill({
				name: 'hidden',
				description: 'no',
				disableModelInvocation: true
			})
		]
		const result = formatSkillsForPrompt(skills)
		expect(result).toContain('visible')
		expect(result).not.toContain('hidden')
	})

	test('escapes XML special characters', () => {
		const skills = [
			makeSkill({
				name: 'safe',
				description: 'Use <tags> & "quotes"'
			})
		]
		const result = formatSkillsForPrompt(skills)
		expect(result).toContain('&lt;tags&gt;')
		expect(result).toContain('&amp;')
		expect(result).toContain('&quot;quotes&quot;')
	})

	test('formats multiple skills', () => {
		const skills = [
			makeSkill({ name: 'alpha', description: 'First' }),
			makeSkill({ name: 'beta', description: 'Second' })
		]
		const result = formatSkillsForPrompt(skills)
		expect(result).toContain('name="alpha"')
		expect(result).toContain('name="beta"')
	})
})
