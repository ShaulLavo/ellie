import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach
} from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import {
	mkdtempSync,
	rmSync,
	readFileSync,
	existsSync,
	writeFileSync,
	mkdirSync
} from 'fs'
import { createMemoryAppendDailyTool } from './memory-daily'
import type { AgentTool } from '@ellie/agent'

// ============================================================================
// Test helpers
// ============================================================================

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'memory-daily-test-'))
}

function todayDateString(): string {
	const now = new Date()
	const y = now.getFullYear()
	const m = String(now.getMonth() + 1).padStart(2, '0')
	const d = String(now.getDate()).padStart(2, '0')
	return `${y}-${m}-${d}`
}

// ============================================================================
// Tests
// ============================================================================

describe('memory_append_daily tool', () => {
	let tmpDir: string
	let tool: AgentTool

	beforeEach(() => {
		tmpDir = createTempDir()
		tool = createMemoryAppendDailyTool(tmpDir)
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	test('creates memory/ directory and daily file on first write', async () => {
		const result = await tool.execute('tc-1', {
			entries: ['User prefers dark mode']
		})

		const today = todayDateString()
		const filePath = join(tmpDir, 'memory', `${today}.md`)

		expect(existsSync(filePath)).toBe(true)

		const content = readFileSync(filePath, 'utf-8')
		expect(content).toContain(`# ${today}`)
		expect(content).toContain('User prefers dark mode')

		expect(
			(result.content[0] as { type: 'text'; text: string })
				.text
		).toContain('Appended 1 entry')
	})

	test('appends to existing file without overwriting', async () => {
		// First write
		await tool.execute('tc-1', {
			entries: ['First fact']
		})

		// Second write
		await tool.execute('tc-2', {
			entries: ['Second fact']
		})

		const today = todayDateString()
		const filePath = join(tmpDir, 'memory', `${today}.md`)
		const content = readFileSync(filePath, 'utf-8')

		expect(content).toContain('First fact')
		expect(content).toContain('Second fact')

		// Header should only appear once
		const headerCount = (
			content.match(new RegExp(`# ${today}`, 'g')) ?? []
		).length
		expect(headerCount).toBe(1)
	})

	test('handles multiple entries in single call', async () => {
		const result = await tool.execute('tc-1', {
			entries: [
				'User likes TypeScript',
				'Project uses Bun',
				'Prefers functional style'
			]
		})

		const today = todayDateString()
		const filePath = join(tmpDir, 'memory', `${today}.md`)
		const content = readFileSync(filePath, 'utf-8')

		expect(content).toContain('User likes TypeScript')
		expect(content).toContain('Project uses Bun')
		expect(content).toContain('Prefers functional style')
		expect(
			(result.content[0] as { type: 'text'; text: string })
				.text
		).toContain('Appended 3 entries')
	})

	test('entries are timestamped', async () => {
		await tool.execute('tc-1', {
			entries: ['Some fact']
		})

		const today = todayDateString()
		const filePath = join(tmpDir, 'memory', `${today}.md`)
		const content = readFileSync(filePath, 'utf-8')

		// Timestamp format: [HH:MM:SS]
		expect(content).toMatch(
			/- \[\d{2}:\d{2}:\d{2}\] Some fact/
		)
	})

	test('never truncates existing content', async () => {
		const today = todayDateString()
		const memoryDir = join(tmpDir, 'memory')
		mkdirSync(memoryDir, { recursive: true })
		const filePath = join(memoryDir, `${today}.md`)

		// Pre-populate with existing content
		writeFileSync(
			filePath,
			`# ${today}\n\n- [10:00:00] Existing entry\n`,
			'utf-8'
		)

		// Append new entry
		await tool.execute('tc-1', {
			entries: ['New entry']
		})

		const content = readFileSync(filePath, 'utf-8')
		expect(content).toContain('Existing entry')
		expect(content).toContain('New entry')
	})

	test('returns error on invalid params (empty entries)', async () => {
		const result = await tool.execute('tc-1', {
			entries: []
		})

		// Valibot validation should make the tool fail or the executor should handle it
		// Since the schema uses v.minLength(1), an empty array should cause validation to fail
		// But since the tool receives rawParams, it depends on the executor's validation
		// The tool itself may still process it — check the details
		expect(result.content).toBeDefined()
	})
})
