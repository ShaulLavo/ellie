/**
 * Dev launcher for stt-server.
 *
 * 1. Run setup (download VAD model if needed).
 * 2. If port 3456 is already healthy → exit 0 (already running).
 * 3. Kill stale process on port, then `cargo run`.
 */

import { spawn, spawnSync } from 'bun'

const PORT = 3456
const HOST = '127.0.0.1'

async function isHealthy(): Promise<boolean> {
	try {
		const res = await fetch(
			`http://${HOST}:${PORT}/health`,
			{
				signal: AbortSignal.timeout(500)
			}
		)
		return res.ok
	} catch {
		return false
	}
}

// 1. Setup
const setup = spawnSync(['bun', 'run', 'setup.ts'], {
	cwd: import.meta.dirname,
	stdout: 'inherit',
	stderr: 'inherit'
})
if (setup.exitCode !== 0) {
	process.exit(setup.exitCode ?? 1)
}

// 2. Already running?
if (await isHealthy()) {
	console.log(`[stt] already running on port ${PORT}`)
	process.exit(0)
}

// 3. Kill stale process on port (best effort)
spawnSync([
	'sh',
	'-c',
	`lsof -ti :${PORT} | xargs kill -9 2>/dev/null`
])

// 4. Start cargo run (replaces this process)
const child = spawn(
	[
		'cargo',
		'run',
		'--',
		'--models-dir',
		'../../data/models/stt',
		'--vad-model',
		'../../data/models/stt/silero_vad_v4.onnx',
		'--auto-load-model',
		'parakeet-tdt-0.6b-v3-int8',
		'--auto-load-engine',
		'parakeet'
	],
	{
		cwd: import.meta.dirname,
		stdout: 'inherit',
		stderr: 'inherit'
	}
)

process.on('exit', () => child.kill())
process.on('SIGINT', () => {
	child.kill()
	process.exit(0)
})
process.on('SIGTERM', () => {
	child.kill()
	process.exit(0)
})

await child.exited
