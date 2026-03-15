/**
 * Simplified auto-setup for Diffusers-based image generation.
 * Creates a Python venv and installs dependencies.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type ProgressFn = (
	label: string,
	status: 'started' | 'running' | 'completed' | 'failed',
	detail?: string,
	step?: number,
	totalSteps?: number,
	preview?: string
) => void

export interface DiffusersSetupResult {
	ready: boolean
	pythonPath: string
	error?: string
}

export type GpuType = 'm-series' | 'nvidia' | 'amd' | 'cpu'

export interface PythonInfo {
	python: string
	version: [number, number, number]
	versionStr: string
}

const MIN_PYTHON_VERSION = [3, 10] as const
const PREFERRED_PYTHON_VERSION = '3.12'
const VENV_DIR_NAME = 'diffusers-venv'
export const VERSION_STAMP = '2' // Bump to force re-install (v2: FastAPI service)

const REQUIRED_PACKAGES = [
	'diffusers',
	'transformers',
	'accelerate',
	'torch',
	'safetensors',
	'huggingface_hub',
	'requests',
	'peft'
]

async function run(
	cmd: string[],
	opts?: { cwd?: string; stdin?: string }
): Promise<{
	ok: boolean
	stdout: string
	stderr: string
}> {
	try {
		if (opts?.stdin != null) {
			const proc = Bun.spawn(cmd, {
				cwd: opts?.cwd,
				stdin: 'pipe' as const,
				stdout: 'pipe' as const,
				stderr: 'pipe' as const,
				env: process.env
			})
			proc.stdin.write(opts.stdin)
			proc.stdin.end()
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text()
			])
			const exitCode = await proc.exited
			return { ok: exitCode === 0, stdout, stderr }
		}

		const proc = Bun.spawn(cmd, {
			cwd: opts?.cwd,
			stdin: 'ignore' as const,
			stdout: 'pipe' as const,
			stderr: 'pipe' as const,
			env: process.env
		})
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text()
		])
		const exitCode = await proc.exited
		return { ok: exitCode === 0, stdout, stderr }
	} catch (err) {
		return {
			ok: false,
			stdout: '',
			stderr:
				err instanceof Error ? err.message : String(err)
		}
	}
}

async function commandExists(
	cmd: string
): Promise<boolean> {
	const result = await run(['which', cmd])
	return result.ok
}

export async function findPython(): Promise<PythonInfo | null> {
	const candidates = [
		'/opt/homebrew/bin/python3.12',
		'/opt/homebrew/bin/python3.13',
		'/opt/homebrew/bin/python3',
		'python3.12',
		'python3.13',
		'python3',
		'python'
	]

	for (const cmd of candidates) {
		const info = await getPythonVersion(cmd)
		if (
			info &&
			info.version[0] >= MIN_PYTHON_VERSION[0] &&
			info.version[1] >= MIN_PYTHON_VERSION[1]
		) {
			return info
		}
	}
	return null
}

async function getPythonVersion(
	pythonCmd: string
): Promise<PythonInfo | null> {
	const result = await run([pythonCmd, '--version'])
	if (!result.ok) return null

	const match = (result.stdout + result.stderr).match(
		/Python (\d+)\.(\d+)\.(\d+)/
	)
	if (!match) return null

	const version: [number, number, number] = [
		parseInt(match[1]),
		parseInt(match[2]),
		parseInt(match[3])
	]

	// Resolve full path
	const whichResult = await run(['which', pythonCmd])
	const pythonPath = whichResult.ok
		? whichResult.stdout.trim()
		: pythonCmd

	// Reject macOS system-framework Python
	const realPathResult = await run(['realpath', pythonPath])
	const realPath = realPathResult.ok
		? realPathResult.stdout.trim()
		: pythonPath
	if (
		realPath.includes(
			'/Library/Frameworks/Python.framework/'
		)
	) {
		return null
	}

	return {
		python: pythonPath,
		version,
		versionStr: `${version[0]}.${version[1]}.${version[2]}`
	}
}

async function installPython(): Promise<PythonInfo | null> {
	const hasBrew = await commandExists('brew')
	if (hasBrew) {
		const result = await run([
			'brew',
			'install',
			`python@${PREFERRED_PYTHON_VERSION}`
		])
		if (result.ok) {
			return findPython()
		}
	}
	return null
}

export async function detectGpuType(): Promise<GpuType> {
	const unameResult = await run(['uname', '-s'])
	const os = unameResult.ok ? unameResult.stdout.trim() : ''

	if (os === 'Darwin') {
		const archResult = await run(['uname', '-m'])
		const arch = archResult.ok
			? archResult.stdout.trim()
			: ''
		return arch === 'arm64' ? 'm-series' : 'cpu'
	}

	const hasNvidiaSmi = await commandExists('nvidia-smi')
	if (hasNvidiaSmi) return 'nvidia'

	const hasRocmSmi = await commandExists('rocm-smi')
	if (hasRocmSmi) return 'amd'

	return 'cpu'
}

async function fixPythonSslCerts(
	py: PythonInfo
): Promise<void> {
	const [major, minor] = py.version

	const unameResult = await run(['uname', '-s'])
	if (
		!unameResult.ok ||
		unameResult.stdout.trim() !== 'Darwin'
	)
		return

	const certScript = `/Applications/Python ${major}.${minor}/Install Certificates.command`
	if (existsSync(certScript)) {
		await run(['/bin/bash', certScript])
		return
	}

	// Fallback: upgrade certifi in venv or system
	await run([
		py.python,
		'-m',
		'pip',
		'install',
		'--upgrade',
		'certifi'
	])
}

let setupLock: Promise<void> = Promise.resolve()

function acquireLock(): Promise<() => void> {
	let release: () => void
	const prev = setupLock
	setupLock = new Promise(r => {
		release = r
	})
	return prev.then(() => release!)
}

export async function ensureDiffusersReady(
	dataDir: string,
	onProgress?: ProgressFn
): Promise<DiffusersSetupResult> {
	const release = await acquireLock()
	try {
		return await doEnsureDiffusersReady(dataDir, onProgress)
	} finally {
		release()
	}
}

async function doEnsureDiffusersReady(
	dataDir: string,
	onProgress?: ProgressFn
): Promise<DiffusersSetupResult> {
	const progress = onProgress ?? (() => {})
	const venvDir = join(dataDir, VENV_DIR_NAME)
	const venvPython = join(venvDir, 'bin', 'python')
	const stampFile = join(venvDir, '.version-stamp')

	// Check if already set up
	if (existsSync(venvPython) && existsSync(stampFile)) {
		const stamp = await Bun.file(stampFile).text()
		if (stamp.trim() === VERSION_STAMP) {
			progress(
				'setup',
				'completed',
				'Diffusers environment ready'
			)
			return { ready: true, pythonPath: venvPython }
		}
	}

	// Find system Python
	progress('setup', 'running', 'Checking Python...', 1, 4)
	let py = await findPython()
	if (!py) {
		progress(
			'setup',
			'running',
			'Installing Python...',
			1,
			4
		)
		py = await installPython()
		if (!py) {
			progress('setup', 'failed', 'Python 3.10+ not found')
			return {
				ready: false,
				pythonPath: '',
				error: `Python 3.10+ is required. Install: brew install python@${PREFERRED_PYTHON_VERSION} (macOS) or sudo apt install python3 (Ubuntu)`
			}
		}
	}
	progress(
		'setup',
		'running',
		`Python ${py.versionStr}`,
		1,
		4
	)

	// Fix SSL certs
	await fixPythonSslCerts(py)

	// Create venv
	if (!existsSync(venvPython)) {
		progress(
			'setup',
			'running',
			'Creating virtual environment...',
			2,
			4
		)
		const venvResult = await run([
			py.python,
			'-m',
			'venv',
			venvDir
		])
		if (!venvResult.ok) {
			progress('setup', 'failed', 'Failed to create venv')
			return {
				ready: false,
				pythonPath: '',
				error: `Failed to create venv: ${venvResult.stderr.slice(0, 200)}`
			}
		}
	}

	// Detect GPU for torch variant
	const gpu = await detectGpuType()
	progress('setup', 'running', `Detected GPU: ${gpu}`, 2, 4)

	// Install packages
	progress(
		'setup',
		'running',
		'Installing dependencies (this may take a few minutes)...',
		3,
		4
	)

	// Build pip install command
	const pipArgs = [
		venvPython,
		'-m',
		'pip',
		'install',
		'--upgrade',
		...REQUIRED_PACKAGES
	]

	const pipResult = await run(pipArgs)
	if (!pipResult.ok) {
		progress('setup', 'failed', 'pip install failed')
		return {
			ready: false,
			pythonPath: '',
			error: `pip install failed: ${pipResult.stderr.slice(0, 500)}`
		}
	}

	// Write version stamp
	await Bun.write(stampFile, VERSION_STAMP)

	progress(
		'setup',
		'completed',
		'Diffusers environment ready',
		4,
		4
	)

	return { ready: true, pythonPath: venvPython }
}
