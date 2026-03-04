/**
 * Auto-start TEI (Text Embeddings Inference) for Hindsight.
 *
 * Spawns two `text-embeddings-router` processes:
 *   - Embed:  BAAI/bge-small-en-v1.5 on port 8080
 *   - Rerank: cross-encoder/ms-marco-MiniLM-L-6-v2 on port 8081
 *
 * Skips launching if the ports are already in use (e.g. user started TEI manually).
 * Kills child processes on server exit.
 *
 * TODO(setup): TEI must be installed locally before running the server.
 *   macOS (Apple Silicon): brew install text-embeddings-inference
 *   Linux / other:         cargo install --path router (from TEI repo)
 *   The binary must be available as `text-embeddings-router` in PATH.
 */

import { spawn, type Subprocess } from 'bun'

const TEI_BINARY = 'text-embeddings-router'

interface TeiInstance {
	name: string
	modelId: string
	port: number
	process?: Subprocess
}

const instances: TeiInstance[] = [
	{
		name: 'embed',
		modelId: 'BAAI/bge-small-en-v1.5',
		port: 8080
	},
	{
		name: 'rerank',
		modelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2',
		port: 8081
	}
]

/** Check if a port is already in use. */
async function isPortInUse(port: number): Promise<boolean> {
	try {
		const res = await fetch(
			`http://localhost:${port}/health`,
			{
				signal: AbortSignal.timeout(500)
			}
		)
		return res.ok
	} catch {
		return false
	}
}

/** Wait for a TEI instance to become healthy. */
async function waitForHealth(
	port: number,
	timeoutMs: number = 60_000
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

/** Check if the TEI binary is available in PATH. */
async function isTeiInstalled(): Promise<boolean> {
	try {
		const proc = spawn(['which', TEI_BINARY], {
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
 * Start TEI instances for Hindsight.
 * Skips instances whose ports are already in use.
 * Returns true if all instances are healthy.
 */
export async function startTei(): Promise<boolean> {
	const installed = await isTeiInstalled()
	if (!installed) {
		console.warn(
			`[tei] '${TEI_BINARY}' not found in PATH. Hindsight semantic search will not work.`
		)
		console.warn(
			'[tei] Install with: brew install text-embeddings-inference'
		)
		return false
	}

	for (const instance of instances) {
		const alreadyRunning = await isPortInUse(instance.port)
		if (alreadyRunning) {
			console.log(
				`[tei] ${instance.name} already running on port ${instance.port}`
			)
			continue
		}

		console.log(
			`[tei] Starting ${instance.name} (${instance.modelId}) on port ${instance.port}...`
		)

		instance.process = spawn(
			[
				TEI_BINARY,
				'--model-id',
				instance.modelId,
				'--port',
				String(instance.port)
			],
			{
				stdout: 'ignore',
				stderr: 'pipe'
			}
		)
	}

	// Wait for all instances to become healthy
	let allHealthy = true
	for (const instance of instances) {
		const healthy = await waitForHealth(instance.port)
		if (healthy) {
			console.log(
				`[tei] ${instance.name} ready on port ${instance.port}`
			)
		} else {
			console.warn(
				`[tei] ${instance.name} failed to start on port ${instance.port}`
			)
			allHealthy = false
		}
	}

	return allHealthy
}

/** Kill all TEI child processes. Called on server shutdown. */
export function stopTei(): void {
	for (const instance of instances) {
		if (instance.process) {
			instance.process.kill()
			instance.process = undefined
		}
	}
}

// Ensure cleanup on exit
process.on('SIGINT', () => {
	stopTei()
	process.exit(0)
})
process.on('SIGTERM', () => {
	stopTei()
	process.exit(0)
})
