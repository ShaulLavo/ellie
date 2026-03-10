/**
 * ComfyUI model registry and setup helpers.
 * Shared by auto-setup (server) and potentially CLI commands.
 */

// ── Model registry ────────────────────────────────────────────────────────────

export interface ModelDownload {
	name: string
	filename: string
	url: string
	dest: string
}

export const CHECKPOINTS: ModelDownload[] = [
	{
		name: 'Stable Diffusion 1.5 (base)',
		filename: 'v1-5-pruned-emaonly.safetensors',
		url: 'https://huggingface.co/sd-legacy/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors',
		dest: 'models/checkpoints'
	},
	{
		name: 'Realizum (SD 1.5, realistic)',
		filename: 'realizum_v10.safetensors',
		url: 'https://civitai.com/api/download/models/1821343',
		dest: 'models/checkpoints'
	},
	{
		name: 'CyberRealistic (SD 1.5, photorealistic)',
		filename: 'cyberrealistic_final.safetensors',
		url: 'https://civitai.com/api/download/models/2681234',
		dest: 'models/checkpoints'
	},
	{
		name: 'PerfectDeliberate v5 (SD 1.5)',
		filename: 'perfectdeliberate_v5SD15.safetensors',
		url: 'https://civitai.com/api/download/models/253055?type=Model&format=SafeTensor&size=pruned&fp=fp16',
		dest: 'models/checkpoints'
	},
	{
		name: 'Moody Real Mix v5 (SD 1.5)',
		filename: 'moodyRealMix_v50.safetensors',
		url: 'https://civitai.com/api/download/models/865501?type=Model&format=SafeTensor&size=pruned&fp=fp16',
		dest: 'models/checkpoints'
	},
	{
		name: 'SDXL 1.0 Base',
		filename: 'sd_xl_base_1.0.safetensors',
		url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
		dest: 'models/checkpoints'
	}
]

export const LORAS: ModelDownload[] = [
	{
		name: 'Perfection Style (detail: hands/faces/bodies)',
		filename: 'perfection style SD1.5.safetensors',
		url: 'https://civitai.com/api/download/models/486099',
		dest: 'models/loras'
	}
]

export const ELLA_MODELS: ModelDownload[] = [
	{
		name: 'ELLA SD1.5 TSC-T5XL',
		filename: 'ella-sd1.5-tsc-t5xl.safetensors',
		url: 'https://huggingface.co/QQGYLab/ELLA/resolve/main/ella-sd1.5-tsc-t5xl.safetensors',
		dest: 'models/ella'
	}
]

// ── Helpers ──────────────────────────────────────────────────────────────────

export async function run(
	cmd: string[],
	opts?: { cwd?: string; stdin?: string }
): Promise<{
	ok: boolean
	stdout: string
	stderr: string
}> {
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

	try {
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

export async function commandExists(
	cmd: string
): Promise<boolean> {
	const result = await run(['which', cmd])
	return result.ok
}

export async function getComfyWorkspace(): Promise<
	string | null
> {
	const result = await run(['comfy', 'env'])
	if (!result.ok) return null

	const lines = result.stdout.split('\n')
	let defaultWs: string | null = null
	let recentWs: string | null = null

	for (const line of lines) {
		const lower = line.toLowerCase()
		if (!lower.includes('workspace')) continue

		const cells = line
			.split(/[│|]/)
			.map(c => c.trim())
			.filter(Boolean)
		if (cells.length < 2) continue

		const value = cells[1]
		if (!value || value.toLowerCase().startsWith('no '))
			continue

		if (lower.includes('default')) {
			defaultWs = value
		} else if (lower.includes('recent')) {
			recentWs = value
		}
	}

	return defaultWs ?? recentWs
}

export async function fileExistsInWorkspace(
	workspace: string,
	relativePath: string
): Promise<boolean> {
	return Bun.file(`${workspace}/${relativePath}`).exists()
}

// ── Python version management ────────────────────────────────────────────────

export const MIN_PYTHON_VERSION = [3, 12] as const
export const PREFERRED_PYTHON_VERSION = '3.12'

export interface PythonInfo {
	python: string
	pip: string
	version: [number, number, number]
	versionStr: string
}

export async function findPython(): Promise<PythonInfo | null> {
	const candidates = [
		// Prefer Homebrew — macOS SIP blocks posix_spawn on
		// /Library/Frameworks/Python.framework/ (system Python)
		'/opt/homebrew/bin/python3.12',
		'/opt/homebrew/bin/python3.13',
		'/opt/homebrew/bin/python3',
		// Then bare commands (may resolve to system Python — filtered below)
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

	// Reject macOS system-framework Python — Bun's posix_spawn
	// gets EACCES on /Library/Frameworks/Python.framework/ paths
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

	const pipCmd = pythonCmd.replace('python', 'pip')
	const pipExists = await commandExists(pipCmd)

	return {
		python: pythonPath,
		pip: pipExists ? pipCmd : `${pythonPath} -m pip`,
		version,
		versionStr: `${version[0]}.${version[1]}.${version[2]}`
	}
}

export async function installPython(): Promise<PythonInfo | null> {
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

export async function installComfyCli(
	py: PythonInfo
): Promise<boolean> {
	const result = await run([
		py.python,
		'-m',
		'pip',
		'install',
		'comfy-cli'
	])
	return result.ok
}

// ── Hardware detection ───────────────────────────────────────────────────────

export type GpuType = 'm-series' | 'nvidia' | 'amd' | 'cpu'

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

export function gpuFlag(gpu: GpuType): string {
	return `--${gpu}`
}

// ── SSL certificate fix ─────────────────────────────────────────────────────

export async function fixPythonSslCerts(
	py: PythonInfo
): Promise<boolean> {
	const [major, minor] = py.version

	const unameResult = await run(['uname', '-s'])
	if (
		!unameResult.ok ||
		unameResult.stdout.trim() !== 'Darwin'
	)
		return true

	const certScript = `/Applications/Python ${major}.${minor}/Install Certificates.command`
	const scriptExists = await Bun.file(certScript).exists()
	if (scriptExists) {
		const result = await run(['/bin/bash', certScript])
		return result.ok
	}

	await run([
		py.python,
		'-m',
		'pip',
		'install',
		'--upgrade',
		'certifi'
	])
	return true
}

// ── Workspace health check ──────────────────────────────────────────────────

export async function isWorkspaceHealthy(
	workspace: string
): Promise<boolean> {
	const comfyEnv = await run(['comfy', 'env'])
	if (!comfyEnv.ok) return false

	const lines = comfyEnv.stdout.split('\n')
	let pythonExe: string | null = null
	for (const line of lines) {
		const lower = line.toLowerCase()
		if (!lower.includes('python executable')) continue
		const cells = line
			.split(/[│|]/)
			.map(c => c.trim())
			.filter(Boolean)
		if (cells.length >= 2) pythonExe = cells[1]
	}

	if (!pythonExe) {
		const result = await run(
			['python3', '-c', 'import torch; import sqlalchemy'],
			{ cwd: workspace }
		)
		return result.ok
	}

	const result = await run([
		pythonExe,
		'-c',
		'import torch; import sqlalchemy'
	])
	return result.ok
}
