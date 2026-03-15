import {
	describe,
	test,
	expect,
	beforeEach,
	afterEach
} from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
	ensureDiffusersReady,
	findPython,
	detectGpuType,
	VERSION_STAMP
} from './auto-setup'
import type { ProgressFn } from './auto-setup'

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`diffusers-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
	)
	mkdirSync(dir, { recursive: true })
	return dir
}

function collectProgress(): {
	calls: Array<Parameters<ProgressFn>>
	fn: ProgressFn
} {
	const calls: Array<Parameters<ProgressFn>> = []
	const fn: ProgressFn = (
		label,
		status,
		detail,
		step,
		totalSteps
	) => {
		calls.push([label, status, detail, step, totalSteps])
	}
	return { calls, fn }
}

describe('findPython', () => {
	test('finds a Python 3.10+ installation', async () => {
		const py = await findPython()
		if (!py) {
			console.warn('No Python 3.10+ found — skipping')
			return
		}
		expect(py.python).toBeTruthy()
		expect(py.version[0]).toBe(3)
		expect(py.version[1]).toBeGreaterThanOrEqual(10)
		expect(py.versionStr).toMatch(/^3\.\d+\.\d+$/)
	})
})

describe('detectGpuType', () => {
	test('returns a valid GPU type', async () => {
		const gpu = await detectGpuType()
		expect(['m-series', 'nvidia', 'amd', 'cpu']).toContain(
			gpu
		)
	})

	test('returns m-series on Darwin arm64', async () => {
		if (
			process.platform === 'darwin' &&
			process.arch === 'arm64'
		) {
			const gpu = await detectGpuType()
			expect(gpu).toBe('m-series')
		}
	})
})

describe('ensureDiffusersReady', () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = makeTmpDir()
	})

	afterEach(() => {
		try {
			rmSync(tmpDir, {
				recursive: true,
				force: true
			})
		} catch {}
	})

	test('detects existing venv with valid stamp and skips creation', async () => {
		const venvDir = join(tmpDir, 'diffusers-venv')
		const binDir = join(venvDir, 'bin')
		mkdirSync(binDir, { recursive: true })
		writeFileSync(join(binDir, 'python'), '#!/bin/sh\n')
		writeFileSync(
			join(venvDir, '.version-stamp'),
			VERSION_STAMP
		)

		const { calls, fn } = collectProgress()
		const result = await ensureDiffusersReady(tmpDir, fn)

		expect(result.ready).toBe(true)
		expect(result.pythonPath).toBe(join(binDir, 'python'))
		const hasCompleted = calls.some(
			c => c[1] === 'completed'
		)
		expect(hasCompleted).toBe(true)
	})

	test('version stamp prevents re-checking on subsequent calls', async () => {
		const venvDir = join(tmpDir, 'diffusers-venv')
		const binDir = join(venvDir, 'bin')
		mkdirSync(binDir, { recursive: true })
		writeFileSync(join(binDir, 'python'), '#!/bin/sh\n')
		writeFileSync(
			join(venvDir, '.version-stamp'),
			VERSION_STAMP
		)

		const result1 = await ensureDiffusersReady(tmpDir)
		expect(result1.ready).toBe(true)

		const result2 = await ensureDiffusersReady(tmpDir)
		expect(result2.ready).toBe(true)
		expect(result2.pythonPath).toBe(result1.pythonPath)
	})

	test('returns correct pythonPath when venv exists', async () => {
		const venvDir = join(tmpDir, 'diffusers-venv')
		const binDir = join(venvDir, 'bin')
		mkdirSync(binDir, { recursive: true })
		writeFileSync(join(binDir, 'python'), '#!/bin/sh\n')
		writeFileSync(
			join(venvDir, '.version-stamp'),
			VERSION_STAMP
		)

		const result = await ensureDiffusersReady(tmpDir)
		expect(result.pythonPath).toContain(
			'diffusers-venv/bin/python'
		)
	})
})
