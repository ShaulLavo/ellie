import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { loadSkills } from './discovery'

function createTempDir(): string {
	return mkdtempSync(
		join(tmpdir(), 'skill-discovery-test-')
	)
}

function createSkillDir(
	base: string,
	name: string,
	content?: string
): string {
	const skillDir = join(base, name)
	mkdirSync(skillDir, { recursive: true })
	writeFileSync(
		join(skillDir, 'SKILL.md'),
		content ??
			`---\nname: ${name}\ndescription: Skill ${name}\n---\n\n# ${name}`
	)
	return skillDir
}

// loadSkills always scans ~/.agents/skills (global), so tests
// filter by source='project' to isolate project-level results.

describe('loadSkills', () => {
	let tmpDir: string

	function setup() {
		tmpDir = createTempDir()
		return tmpDir
	}

	function cleanup() {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	}

	test('returns no project skills when no project skill dirs exist', () => {
		const dir = setup()
		const result = loadSkills({ cwd: dir })
		const projectSkills = result.skills.filter(
			s => s.source === 'project'
		)
		expect(projectSkills).toEqual([])
		cleanup()
	})

	test('discovers project skills from .agents/skills', () => {
		const dir = setup()
		const skillsDir = join(dir, '.agents', 'skills')
		mkdirSync(skillsDir, { recursive: true })
		createSkillDir(skillsDir, 'my-skill')

		const result = loadSkills({ cwd: dir })
		const projectSkills = result.skills.filter(
			s => s.source === 'project'
		)

		expect(projectSkills).toHaveLength(1)
		expect(projectSkills[0].name).toBe('my-skill')
		expect(projectSkills[0].source).toBe('project')
		cleanup()
	})

	test('discovers project skills from .claude/skills', () => {
		const dir = setup()
		const skillsDir = join(dir, '.claude', 'skills')
		mkdirSync(skillsDir, { recursive: true })
		createSkillDir(skillsDir, 'claude-skill')

		const result = loadSkills({ cwd: dir })
		const projectSkills = result.skills.filter(
			s => s.source === 'project'
		)

		expect(projectSkills).toHaveLength(1)
		expect(projectSkills[0].name).toBe('claude-skill')
		cleanup()
	})

	test('deduplicates skills by name across project dirs', () => {
		const dir = setup()

		// Create same-named skill in both project dirs
		const agentsDir = join(dir, '.agents', 'skills')
		const claudeDir = join(dir, '.claude', 'skills')
		mkdirSync(agentsDir, { recursive: true })
		mkdirSync(claudeDir, { recursive: true })
		createSkillDir(agentsDir, 'dupe-skill')
		createSkillDir(claudeDir, 'dupe-skill')

		const result = loadSkills({ cwd: dir })
		const dupes = result.skills.filter(
			s => s.name === 'dupe-skill'
		)

		// First found wins (.agents before .claude)
		expect(dupes).toHaveLength(1)
		expect(
			result.diagnostics.some(
				d =>
					d.type === 'warning' &&
					d.message.includes('Duplicate skill name')
			)
		).toBe(true)
		cleanup()
	})

	test('reports diagnostics for invalid skills', () => {
		const dir = setup()
		const skillsDir = join(dir, '.agents', 'skills')
		mkdirSync(skillsDir, { recursive: true })

		// Create skill with invalid frontmatter
		const badDir = join(skillsDir, 'bad-skill')
		mkdirSync(badDir)
		writeFileSync(
			join(badDir, 'SKILL.md'),
			'No frontmatter here'
		)

		const result = loadSkills({ cwd: dir })
		const projectSkills = result.skills.filter(
			s => s.source === 'project'
		)

		expect(projectSkills).toHaveLength(0)
		expect(
			result.diagnostics.some(
				d =>
					d.type === 'error' &&
					d.message.includes(
						'Missing or invalid YAML frontmatter'
					)
			)
		).toBe(true)
		cleanup()
	})

	test('discovers multiple project skills', () => {
		const dir = setup()
		const skillsDir = join(dir, '.agents', 'skills')
		mkdirSync(skillsDir, { recursive: true })
		createSkillDir(skillsDir, 'alpha')
		createSkillDir(skillsDir, 'beta')

		const result = loadSkills({ cwd: dir })
		const projectSkills = result.skills.filter(
			s => s.source === 'project'
		)

		expect(projectSkills).toHaveLength(2)
		const names = projectSkills.map(s => s.name).sort()
		expect(names).toEqual(['alpha', 'beta'])
		cleanup()
	})

	test('ignores non-directory entries', () => {
		const dir = setup()
		const skillsDir = join(dir, '.agents', 'skills')
		mkdirSync(skillsDir, { recursive: true })
		writeFileSync(
			join(skillsDir, 'not-a-dir'),
			'just a file'
		)
		createSkillDir(skillsDir, 'real-skill')

		const result = loadSkills({ cwd: dir })
		const projectSkills = result.skills.filter(
			s => s.source === 'project'
		)

		expect(projectSkills).toHaveLength(1)
		expect(projectSkills[0].name).toBe('real-skill')
		cleanup()
	})
})
