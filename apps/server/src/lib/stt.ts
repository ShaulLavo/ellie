/**
 * Auto-start stt-server (Speech-to-Text) for voice transcription.
 *
 * Spawns the `stt-server` Rust binary on port 3456 with the default
 * Parakeet model for fast local transcription.
 *
 * Dev:  builds via `cargo build` then runs the debug binary directly.
 * Prod: expects `stt-server` binary in PATH.
 *
 * Skips launching if the port is already in use (e.g. user started STT manually).
 * Downloads the VAD model from GitHub if not present.
 * Kills child process on server exit.
 */

import { spawn, type Subprocess } from 'bun'
import { resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

const STT_PORT = 3456
const STT_HOST = '127.0.0.1'

const MONOREPO_ROOT = resolve(
	import.meta.dir,
	'../../../..'
)
const STT_CRATE_DIR = resolve(MONOREPO_ROOT, 'apps/stt')
const DEBUG_BINARY = resolve(
	STT_CRATE_DIR,
	'target/debug/stt-server'
)
const RELEASE_BINARY = resolve(
	STT_CRATE_DIR,
	'target/release/stt-server'
)
const MODELS_DIR = resolve(MONOREPO_ROOT, 'data/models/stt')
const VAD_MODEL_PATH = resolve(
	MODELS_DIR,
	'silero_vad_v4.onnx'
)
const VAD_MODEL_URL =
	'https://github.com/snakers4/silero-vad/raw/v4.0/files/silero_vad.onnx'

const AUTO_LOAD_MODEL = 'parakeet-tdt-0.6b-v3-int8'
const AUTO_LOAD_ENGINE = 'parakeet'

let sttProcess: Subprocess | undefined

/** Download Silero VAD model if not already present. */
async function ensureVadModel(): Promise<void> {
	mkdirSync(MODELS_DIR, { recursive: true })

	if (existsSync(VAD_MODEL_PATH)) return

	console.log(
		`[stt] Downloading Silero VAD v4 model to ${VAD_MODEL_PATH}...`
	)
	const res = await fetch(VAD_MODEL_URL, {
		redirect: 'follow'
	})
	if (!res.ok)
		throw new Error(
			`[stt] Failed to download VAD model: ${res.status}`
		)
	await Bun.write(VAD_MODEL_PATH, res)
	console.log('[stt] VAD model downloaded.')
}

/** Check if the STT port is already in use. */
async function isPortInUse(port: number): Promise<boolean> {
	try {
		const res = await fetch(
			`http://localhost:${port}/health`,
			{ signal: AbortSignal.timeout(500) }
		)
		return res.ok
	} catch {
		return false
	}
}

/** Wait for the STT server to become healthy. */
async function waitForHealth(
	port: number,
	timeoutMs: number = 120_000
): Promise<boolean> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(
				`http://localhost:${port}/health`,
				{ signal: AbortSignal.timeout(1000) }
			)
			if (res.ok) return true
		} catch {
			// not ready yet
		}
		await Bun.sleep(500)
	}
	return false
}

/** Check if a binary is available in PATH. */
async function isInPath(binary: string): Promise<boolean> {
	try {
		const proc = spawn(['which', binary], {
			stdout: 'pipe',
			stderr: 'pipe'
		})
		const code = await proc.exited
		return code === 0
	} catch {
		return false
	}
}

/**
 * Find the stt-server binary. Resolution order:
 * 1. `stt-server` in PATH (production / global install)
 * 2. Release binary at apps/stt/target/release/stt-server
 * 3. Debug binary at apps/stt/target/debug/stt-server
 */
async function findBinary(): Promise<string | null> {
	if (await isInPath('stt-server')) return 'stt-server'
	if (existsSync(RELEASE_BINARY)) return RELEASE_BINARY
	if (existsSync(DEBUG_BINARY)) return DEBUG_BINARY
	return null
}

/**
 * Build the stt-server binary via cargo build.
 * Returns the debug binary path on success, null on failure.
 */
async function cargoBuild(): Promise<string | null> {
	if (!(await isInPath('cargo'))) return null

	console.log(
		'[stt] Building stt-server (first start may be slow)...'
	)
	const proc = spawn(
		[
			'cargo',
			'build',
			'--manifest-path',
			resolve(STT_CRATE_DIR, 'Cargo.toml')
		],
		{
			stdout: 'ignore',
			stderr: 'ignore'
		}
	)
	const code = await proc.exited
	if (code !== 0) {
		console.warn('[stt] cargo build failed')
		return null
	}

	if (existsSync(DEBUG_BINARY)) return DEBUG_BINARY
	return null
}

/** Build the CLI args for the stt-server binary. */
function buildArgs(): string[] {
	return [
		'--models-dir',
		MODELS_DIR,
		'--vad-model',
		VAD_MODEL_PATH,
		'--port',
		String(STT_PORT),
		'--host',
		STT_HOST,
		'--auto-load-model',
		AUTO_LOAD_MODEL,
		'--auto-load-engine',
		AUTO_LOAD_ENGINE
	]
}

/**
 * Start the STT server.
 * Finds or builds the binary, then spawns it directly.
 * Skips if the port is already in use.
 */
export async function startStt(): Promise<boolean> {
	await ensureVadModel()

	const alreadyRunning = await isPortInUse(STT_PORT)
	if (alreadyRunning) {
		console.log(`[stt] already running on port ${STT_PORT}`)
		return true
	}

	let binary = await findBinary()

	if (!binary) {
		binary = await cargoBuild()
		if (!binary) {
			console.warn(
				'[stt] No stt-server binary found and cargo build failed. Speech-to-text will not work.'
			)
			return false
		}
	}

	console.log(
		`[stt] Starting stt-server on port ${STT_PORT}...`
	)
	sttProcess = spawn([binary, ...buildArgs()], {
		stdout: 'ignore',
		stderr: 'ignore'
	})

	const healthy = await waitForHealth(STT_PORT)
	if (healthy) {
		console.log(`[stt] ready on port ${STT_PORT}`)
	} else {
		console.warn(
			`[stt] failed to start on port ${STT_PORT}`
		)
	}

	return healthy
}

/** Kill the STT child process. Called on server shutdown. */
export function stopStt(): void {
	if (sttProcess) {
		sttProcess.kill()
		sttProcess = undefined
	}
}

// Use 'exit' event for cleanup — TEI's SIGINT/SIGTERM handlers
// call process.exit(0) before other signal handlers can run,
// but 'exit' always fires.
process.on('exit', () => stopStt())
