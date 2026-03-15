/**
 * Terminal WebSocket route — streams a PTY-hosted TUI to the browser.
 *
 * Uses a Go pty-bridge binary that spawns the TUI in a real
 * pseudo-terminal and bridges stdin/stdout over pipes.
 *
 * Protocol (pty-bridge):
 *   stdin:  0x00 + bytes → raw terminal input
 *           0x01 + JSON  → resize {"cols":N,"rows":N}
 *   stdout: raw terminal output
 *
 * Protocol (WebSocket via Eden):
 *   client → server: { type:"input", data:string } | { type:"resize", cols, rows }
 *   server → client: raw terminal output strings
 */

import { Elysia } from 'elysia'
import * as v from 'valibot'
import type { Subprocess } from 'bun'
import { resolve } from 'node:path'

const INPUT_PREFIX = new Uint8Array([0x00])
const RESIZE_PREFIX = new Uint8Array([0x01])
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const bridges = new Map<string, Subprocess>()

const CLI_DIR = resolve(import.meta.dir, '../../../cli')
const IS_DEV = process.env.NODE_ENV === 'development'

/** Rebuild Go CLI binaries. Returns a promise that resolves when done. */
async function rebuildCliBinaries() {
	const targets = [
		{ out: 'bin/ellie', pkg: './cmd/ellie' },
		{ out: 'bin/pty-bridge', pkg: './cmd/pty-bridge' }
	]
	const builds = targets.map(async ({ out, pkg }) => {
		const proc = Bun.spawn(
			['go', 'build', '-o', out, pkg],
			{
				cwd: CLI_DIR,
				stdout: 'ignore',
				stderr: 'pipe'
			}
		)
		const exitCode = await proc.exited
		if (exitCode !== 0) {
			const msg = await new Response(proc.stderr).text()
			console.error(
				`[terminal] go build ${pkg} failed:\n${msg}`
			)
		}
	})
	await Promise.all(builds)
	console.log('[terminal] CLI binaries rebuilt')
}

// In dev mode, rebuild binaries in the background. The promise gates
// WebSocket connections so the first connect waits for the build.
const devBuildReady = IS_DEV
	? rebuildCliBinaries()
	: Promise.resolve()

export function createTerminalRoutes(paths?: {
	bridge?: string
	cli?: string
}) {
	const bridgePath =
		paths?.bridge ?? resolve(CLI_DIR, 'bin/pty-bridge')
	const cliPath =
		paths?.cli ?? resolve(CLI_DIR, 'bin/ellie')

	return new Elysia({ tags: ['Terminal'] }).ws(
		'/api/ws/terminal',
		{
			body: v.union([
				v.object({
					type: v.literal('input'),
					data: v.string()
				}),
				v.object({
					type: v.literal('resize'),
					cols: v.number(),
					rows: v.number()
				})
			]),

			response: v.string(),

			async open(ws) {
				await devBuildReady
				const proc = Bun.spawn([bridgePath, cliPath], {
					stdin: 'pipe',
					stdout: 'pipe',
					stderr: 'inherit'
				})

				bridges.set(ws.id, proc)

				// Pump PTY output → WebSocket
				const reader = proc.stdout.getReader()

				async function pump() {
					try {
						while (true) {
							const { done, value } = await reader.read()
							if (done) break
							try {
								ws.send(decoder.decode(value))
							} catch {
								break
							}
						}
					} finally {
						try {
							ws.close()
						} catch {
							// already closed
						}
					}
				}

				pump()
			},

			message(ws, message) {
				const proc = bridges.get(ws.id)
				const stdin = proc?.stdin
				if (!stdin || typeof stdin === 'number') return

				if (message.type === 'resize') {
					const json = encoder.encode(
						JSON.stringify({
							cols: message.cols,
							rows: message.rows
						})
					)
					const payload = new Uint8Array(1 + json.length)
					payload.set(RESIZE_PREFIX)
					payload.set(json, 1)
					stdin.write(payload)
				} else {
					const encoded = encoder.encode(message.data)
					const payload = new Uint8Array(1 + encoded.length)
					payload.set(INPUT_PREFIX)
					payload.set(encoded, 1)
					stdin.write(payload)
				}
			},

			close(ws) {
				bridges.get(ws.id)?.kill()
				bridges.delete(ws.id)
			}
		}
	)
}
