import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { validateMetadata, validate } from './validator'

describe('validateMetadata', () => {
	test('accepts valid metadata', () => {
		const errors = validateMetadata({
			name: 'my-skill',
			description: 'A useful skill'
		})
		expect(errors).toEqual([])
	})

	test('requires name field', () => {
		const errors = validateMetadata({
			description: 'A useful skill'
		})
		expect(errors).toContain(
			'Missing required field in frontmatter: name'
		)
	})

	test('requires description field', () => {
		const errors = validateMetadata({
			name: 'my-skill'
		})
		expect(errors).toContain(
			'Missing required field in frontmatter: description'
		)
	})

	test('rejects uppercase names', () => {
		const errors = validateMetadata({
			name: 'MySkill',
			description: 'test'
		})
		expect(
			errors.some(e => e.includes('must be lowercase'))
		).toBe(true)
	})

	test('rejects names starting with hyphen', () => {
		const errors = validateMetadata({
			name: '-my-skill',
			description: 'test'
		})
		expect(
			errors.some(e =>
				e.includes('cannot start or end with a hyphen')
			)
		).toBe(true)
	})

	test('rejects names ending with hyphen', () => {
		const errors = validateMetadata({
			name: 'my-skill-',
			description: 'test'
		})
		expect(
			errors.some(e =>
				e.includes('cannot start or end with a hyphen')
			)
		).toBe(true)
	})

	test('rejects consecutive hyphens', () => {
		const errors = validateMetadata({
			name: 'my--skill',
			description: 'test'
		})
		expect(
			errors.some(e => e.includes('consecutive hyphens'))
		).toBe(true)
	})

	test('rejects names with invalid characters', () => {
		const errors = validateMetadata({
			name: 'my_skill',
			description: 'test'
		})
		expect(
			errors.some(e => e.includes('invalid characters'))
		).toBe(true)
	})

	test('rejects names exceeding 64 chars', () => {
		const errors = validateMetadata({
			name: 'a'.repeat(65),
			description: 'test'
		})
		expect(
			errors.some(e =>
				e.includes('exceeds 64 character limit')
			)
		).toBe(true)
	})

	test('rejects descriptions exceeding 1024 chars', () => {
		const errors = validateMetadata({
			name: 'my-skill',
			description: 'x'.repeat(1025)
		})
		expect(
			errors.some(e =>
				e.includes('exceeds 1024 character limit')
			)
		).toBe(true)
	})

	test('validates compatibility length', () => {
		const errors = validateMetadata({
			name: 'my-skill',
			description: 'test',
			compatibility: 'x'.repeat(501)
		})
		expect(
			errors.some(e =>
				e.includes('exceeds 500 character limit')
			)
		).toBe(true)
	})

	test('rejects unexpected fields', () => {
		const errors = validateMetadata({
			name: 'my-skill',
			description: 'test',
			bogus: true
		})
		expect(
			errors.some(e => e.includes('Unexpected fields'))
		).toBe(true)
	})

	test('checks dirName matches skill name', () => {
		const errors = validateMetadata(
			{
				name: 'my-skill',
				description: 'test'
			},
			'other-dir'
		)
		expect(
			errors.some(e => e.includes('must match skill name'))
		).toBe(true)
	})

	test('passes when dirName matches skill name', () => {
		const errors = validateMetadata(
			{
				name: 'my-skill',
				description: 'test'
			},
			'my-skill'
		)
		expect(errors).toEqual([])
	})
})

describe('validate', () => {
	let tmpDir: string

	function setup() {
		tmpDir = mkdtempSync(
			join(tmpdir(), 'skill-validate-test-')
		)
		return tmpDir
	}

	function cleanup() {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true })
		}
	}

	test('rejects non-existent path', () => {
		const errors = validate('/nonexistent/path')
		expect(errors[0]).toContain('does not exist')
	})

	test('rejects non-directory path', () => {
		const dir = setup()
		const file = join(dir, 'not-a-dir')
		writeFileSync(file, 'hello')
		const errors = validate(file)
		expect(errors[0]).toContain('Not a directory')
		cleanup()
	})

	test('rejects directory without SKILL.md', () => {
		const dir = setup()
		const skillDir = join(dir, 'my-skill')
		mkdirSync(skillDir)
		const errors = validate(skillDir)
		expect(errors[0]).toContain(
			'Missing required file: SKILL.md'
		)
		cleanup()
	})

	test('rejects SKILL.md without frontmatter', () => {
		const dir = setup()
		const skillDir = join(dir, 'my-skill')
		mkdirSync(skillDir)
		writeFileSync(
			join(skillDir, 'SKILL.md'),
			'# Just markdown, no frontmatter'
		)
		const errors = validate(skillDir)
		expect(errors[0]).toContain(
			'Missing or invalid YAML frontmatter'
		)
		cleanup()
	})

	test('validates a correct skill directory', () => {
		const dir = setup()
		const skillDir = join(dir, 'my-skill')
		mkdirSync(skillDir)
		writeFileSync(
			join(skillDir, 'SKILL.md'),
			'---\nname: my-skill\ndescription: A useful skill\n---\n\n# My Skill'
		)
		const errors = validate(skillDir)
		expect(errors).toEqual([])
		cleanup()
	})
})
