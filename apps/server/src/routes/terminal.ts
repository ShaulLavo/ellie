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

import { Elysia, t } from 'elysia'
import type { Subprocess } from 'bun'
import { resolve } from 'node:path'

const INPUT_PREFIX = new Uint8Array([0x00])
const RESIZE_PREFIX = new Uint8Array([0x01])
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const bridges = new Map<string, Subprocess>()

export function createTerminalRoutes(paths?: {
	bridge?: string
	cli?: string
}) {
	const bridgePath =
		paths?.bridge ??
		resolve(import.meta.dir, '../../../cli/bin/pty-bridge')
	const cliPath =
		paths?.cli ??
		resolve(import.meta.dir, '../../../cli/bin/ellie')

	return new Elysia({ tags: ['Terminal'] }).ws(
		'/ws/terminal',
		{
			body: t.Union([
				t.Object({
					type: t.Literal('input'),
					data: t.String()
				}),
				t.Object({
					type: t.Literal('resize'),
					cols: t.Number(),
					rows: t.Number()
				})
			]),

			response: t.String(),

			open(ws) {
				const proc = Bun.spawn(
					[bridgePath, cliPath, 'chat'],
					{
						stdin: 'pipe',
						stdout: 'pipe',
						stderr: 'inherit'
					}
				)

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
