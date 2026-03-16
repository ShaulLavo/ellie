import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { expandSkillCommand } from './expand'
import type { Skill } from './types'

function makeSkill(
	filePath: string,
	overrides?: Partial<Skill>
): Skill {
	return {
		name: 'my-skill',
		description: 'A test skill',
		filePath,
		baseDir: '/skills',
		source: 'project',
		...overrides
	}
}

describe('expandSkillCommand', () => {
	let tmpDir: string

	function setup() {
		tmpDir = mkdtempSync(
			join(tmpdir(), 'skill-expand-test-')
		)
		return tmpDir
	}

	function cleanup() {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	}

	test('returns input unchanged for non-skill text', () => {
		const result = expandSkillCommand('hello world', [])
		expect(result).toBe('hello world')
	})

	test('returns input unchanged for unknown skill name', () => {
		const result = expandSkillCommand('/skill:unknown', [])
		expect(result).toBe('/skill:unknown')
	})

	test('expands a known skill command', () => {
		const dir = setup()
		const skillDir = join(dir, 'my-skill')
		mkdirSync(skillDir)
		const skillFile = join(skillDir, 'SKILL.md')
		writeFileSync(
			skillFile,
			'---\nname: my-skill\ndescription: test\n---\n\nSkill body content here.'
		)

		const skills = [makeSkill(skillFile)]
		const result = expandSkillCommand(
			'/skill:my-skill',
			skills
		)

		expect(result).toContain('<skill name="my-skill"')
		expect(result).toContain('Skill body content here.')
		expect(result).not.toContain('---')
		cleanup()
	})

	test('strips frontmatter from expanded skill', () => {
		const dir = setup()
		const skillDir = join(dir, 'my-skill')
		mkdirSync(skillDir)
		const skillFile = join(skillDir, 'SKILL.md')
		writeFileSync(
			skillFile,
			'---\nname: my-skill\ndescription: test\n---\n\nBody only.'
		)

		const skills = [makeSkill(skillFile)]
		const result = expandSkillCommand(
			'/skill:my-skill',
			skills
		)

		expect(result).toContain('Body only.')
		expect(result).not.toContain('name: my-skill')
		cleanup()
	})

	test('appends trailing arguments after skill block', () => {
		const dir = setup()
		const skillDir = join(dir, 'my-skill')
		mkdirSync(skillDir)
		const skillFile = join(skillDir, 'SKILL.md')
		writeFileSync(
			skillFile,
			'---\nname: my-skill\ndescription: test\n---\n\nBody.'
		)

		const skills = [makeSkill(skillFile)]
		const result = expandSkillCommand(
			'/skill:my-skill extra args here',
			skills
		)

		expect(result).toContain('</skill>')
		expect(result).toContain('extra args here')
		cleanup()
	})

	test('returns input if skill file is unreadable', () => {
		const skills = [makeSkill('/nonexistent/SKILL.md')]
		const result = expandSkillCommand(
			'/skill:my-skill',
			skills
		)
		expect(result).toBe('/skill:my-skill')
	})
})
