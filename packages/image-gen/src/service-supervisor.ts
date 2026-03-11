/**
 * Service supervisor — manages the Python FastAPI service lifecycle.
 *
 * Responsibilities:
 *   - Ensure Python venv exists and local package is installed
 *   - Spawn uvicorn on a random available port
 *   - Wait for /health readiness
 *   - Provide an HTTP client for generation requests
 *   - Stop the service on Bun server shutdown
 */

import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { ensureDiffusersReady } from './auto-setup'
import type { ProgressFn } from './auto-setup'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ServiceConfig {
	dataDir: string
	onProgress?: ProgressFn
}

export interface ServiceState {
	port: number
	baseUrl: string
	proc: { kill(): void; exited: Promise<number> }
}

// ── Singleton state ──────────────────────────────────────────────────────────

let activeService: ServiceState | null = null
let startLock: Promise<ServiceState> | null = null

const PYTHON_PACKAGE_DIR = join(
	dirname(new URL(import.meta.url).pathname),
	'..',
	'python'
)

const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_POLL_MS = 300

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure the FastAPI image generation service is running.
 * Returns the base URL for HTTP requests.
 */
export async function ensureImageGenService(
	config: ServiceConfig
): Promise<string> {
	if (activeService) {
		// Verify still alive
		try {
			const resp = await fetch(
				`${activeService.baseUrl}/health`,
				{ signal: AbortSignal.timeout(2000) }
			)
			if (resp.ok) return activeService.baseUrl
		} catch {
			// Dead — restart
			await stopImageGenService()
		}
	}

	// Prevent concurrent starts
	if (startLock) {
		const state = await startLock
		return state.baseUrl
	}

	startLock = doStart(config)
	try {
		const state = await startLock
		activeService = state
		return state.baseUrl
	} finally {
		startLock = null
	}
}

/**
 * Stop the FastAPI service if running.
 */
export async function stopImageGenService(): Promise<void> {
	if (!activeService) return
	try {
		activeService.proc.kill()
	} catch {}
	activeService = null
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function doStart(
	config: ServiceConfig
): Promise<ServiceState> {
	const { dataDir, onProgress } = config
	const progress = onProgress ?? (() => {})

	// 1. Ensure Python venv + deps
	progress(
		'setup',
		'started',
		'Preparing Diffusers environment...'
	)
	const setupResult = await ensureDiffusersReady(
		dataDir,
		onProgress
	)
	if (!setupResult.ready) {
		throw new Error(
			`Diffusers setup failed: ${setupResult.error}`
		)
	}
	progress('setup', 'completed', 'Python environment ready')

	// 2. Install the local Python package (if pyproject.toml exists)
	const pyprojectPath = join(
		PYTHON_PACKAGE_DIR,
		'pyproject.toml'
	)
	if (existsSync(pyprojectPath)) {
		progress(
			'setup',
			'running',
			'Installing image-gen Python package...'
		)
		const installProc = Bun.spawn(
			[
				setupResult.pythonPath,
				'-m',
				'pip',
				'install',
				'-e',
				PYTHON_PACKAGE_DIR,
				'--quiet'
			],
			{
				stdout: 'pipe',
				stderr: 'pipe',
				env: process.env
			}
		)
		const installExit = await installProc.exited
		if (installExit !== 0) {
			const stderr = await new Response(
				installProc.stderr
			).text()
			throw new Error(
				`Failed to install Python package: ${stderr.slice(0, 500)}`
			)
		}
	}

	// 3. Pick a random port and spawn uvicorn
	const port = 9819 + Math.floor(Math.random() * 1000)
	progress(
		'setup',
		'running',
		`Starting image-gen service on port ${port}...`
	)

	const proc = Bun.spawn(
		[
			setupResult.pythonPath,
			'-m',
			'uvicorn',
			'ellie_image_gen.main:create_app',
			'--factory',
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
			'--log-level',
			'warning'
		],
		{
			stdout: 'pipe',
			stderr: 'pipe',
			env: process.env
		}
	)

	// Monitor unexpected exits
	proc.exited.then(code => {
		if (activeService?.proc === proc) {
			console.warn(
				`[image-gen] Service exited unexpectedly: code ${code}`
			)
			activeService = null
		}
	})

	const baseUrl = `http://127.0.0.1:${port}`

	// 4. Wait for /health
	let procExited = false
	let procExitCode = 0
	proc.exited.then(code => {
		procExited = true
		procExitCode = code
	})

	const deadline = Date.now() + HEALTH_TIMEOUT_MS
	while (Date.now() < deadline) {
		// If uvicorn already crashed, fail fast with stderr
		if (procExited) {
			let stderr = ''
			try {
				stderr = await new Response(
					proc.stderr as ReadableStream
				).text()
			} catch {}
			throw new Error(
				`Image-gen service exited during startup (code ${procExitCode}): ${stderr.slice(-500)}`
			)
		}

		try {
			const resp = await fetch(`${baseUrl}/health`, {
				signal: AbortSignal.timeout(1000)
			})
			if (resp.ok) {
				progress(
					'setup',
					'completed',
					'Image-gen service ready'
				)
				return { port, baseUrl, proc }
			}
		} catch {
			// Not ready yet
		}
		await new Promise(r => setTimeout(r, HEALTH_POLL_MS))
	}

	// Timed out — grab stderr for diagnostics
	proc.kill()
	let stderr = ''
	try {
		stderr = await new Response(
			proc.stderr as ReadableStream
		).text()
	} catch {}
	throw new Error(
		`Image-gen service failed to start within ${HEALTH_TIMEOUT_MS / 1000}s. stderr: ${stderr.slice(-500)}`
	)
}
