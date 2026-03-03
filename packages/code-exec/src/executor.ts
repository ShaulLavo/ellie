import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlink, writeFile } from 'node:fs/promises'
import { ulid } from 'fast-ulid'
import { buildScript } from './script-builder'
import {
	DEFAULTS,
	ExecutionError,
	type ExecuteOptions,
	type ToolClient,
	type ToolDefinition
} from './types'

interface ToolCallMessage {
	__ce_call__: true
	id: string
	tool: string
	args: Record<string, unknown>
}

function isToolCall(msg: unknown): msg is ToolCallMessage {
	if (typeof msg !== 'object' || msg === null) return false
	const obj = msg as Record<string, unknown>
	return (
		obj.__ce_call__ === true &&
		typeof obj.id === 'string' &&
		typeof obj.tool === 'string' &&
		typeof obj.args === 'object' &&
		obj.args !== null
	)
}

/**
 * Execute user code in a Bun child process, bridging tool
 * calls over IPC.
 */
export async function execute(
	userCode: string,
	tools: ToolDefinition[],
	toolClient: ToolClient,
	options?: ExecuteOptions
): Promise<string> {
	const opts = {
		timeoutMs: options?.timeoutMs ?? DEFAULTS.timeoutMs,
		maxToolCalls:
			options?.maxToolCalls ?? DEFAULTS.maxToolCalls,
		maxOutputBytes:
			options?.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
		captureStderrBytes:
			options?.captureStderrBytes ??
			DEFAULTS.captureStderrBytes,
		tempDir: options?.tempDir ?? tmpdir()
	}

	// ── 1. Build & write temp script ────────────────────────────────
	const script = await buildScript(userCode, tools)
	const tmpFile = join(opts.tempDir, `ce-${ulid()}.ts`)
	await writeFile(tmpFile, script, 'utf-8')

	// ── 2. Spawn child with IPC ─────────────────────────────────────
	let toolCallCount = 0
	let limitError: ExecutionError | null = null
	let timedOut = false

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bun.spawn generics vary by stdio config
	let proc: {
		kill(): void
		send(msg: unknown): void
		stdout: unknown
		stderr: unknown
		exited: Promise<number | null>
	}
	try {
		proc = Bun.spawn(
			[
				process.execPath,
				'--install=fallback',
				'run',
				tmpFile
			],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				env: process.env as Record<string, string>,
				ipc(message) {
					if (limitError) return
					if (!isToolCall(message)) return

					toolCallCount++
					if (toolCallCount > opts.maxToolCalls) {
						limitError = new ExecutionError(
							'SCRIPT_RUNTIME',
							`Exceeded max tool calls (${opts.maxToolCalls})`,
							{
								toolCallsUsed: toolCallCount
							}
						)
						proc?.kill()
						return
					}

					toolClient
						.callTool(message.tool, message.args)
						.then(result => {
							try {
								proc?.send({
									__ce_result__: true,
									id: message.id,
									result
								})
							} catch {
								/* child already exited */
							}
						})
						.catch(err => {
							const errMsg =
								err instanceof Error
									? err.message
									: String(err)
							try {
								proc?.send({
									__ce_result__: true,
									id: message.id,
									error: errMsg
								})
							} catch {
								/* child already exited */
							}
						})
				}
			}
		)
	} catch (err) {
		await cleanup(tmpFile)
		throw new ExecutionError(
			'SPAWN_FAILED',
			'Failed to spawn child process',
			{
				cause: err
			}
		)
	}

	const timer = setTimeout(() => {
		timedOut = true
		proc.kill()
	}, opts.timeoutMs)

	// ── 3. Read streams & wait for exit ─────────────────────────────
	try {
		// Stdout reader (pure output — no protocol mixing)
		const outputChunks: string[] = []
		let outputBytes = 0
		const stdoutReader = (
			proc.stdout as ReadableStream<Uint8Array>
		).getReader()
		const stdoutDecoder = new TextDecoder()

		const stdoutDrain = (async () => {
			try {
				while (true) {
					if (limitError) break
					const { done, value } = await stdoutReader.read()
					if (done) break
					outputBytes += value.byteLength
					if (outputBytes > opts.maxOutputBytes) {
						limitError = new ExecutionError(
							'OUTPUT_LIMIT',
							`Output exceeded ${opts.maxOutputBytes} bytes`,
							{ outputBytes }
						)
						proc.kill()
						break
					}
					outputChunks.push(
						stdoutDecoder.decode(value, {
							stream: true
						})
					)
				}
			} catch {
				/* stream closed */
			}
		})()

		// Stderr collector (bounded)
		let stderrBuf = ''
		let stderrBytes = 0
		const stderrReader = (
			proc.stderr as ReadableStream<Uint8Array>
		).getReader()
		const stderrDecoder = new TextDecoder()

		const stderrDrain = (async () => {
			try {
				while (true) {
					const { done, value } = await stderrReader.read()
					if (done) break
					if (stderrBytes >= opts.captureStderrBytes)
						continue
					stderrBuf += stderrDecoder.decode(value, {
						stream: true
					})
					stderrBytes += value.byteLength
				}
			} catch {
				/* stream closed */
			}
		})()

		// Wait for child to exit and streams to drain
		const exitCode = await proc.exited
		await Promise.all([stdoutDrain, stderrDrain])

		// Priority order: limit errors > timeout > non-zero exit
		if (limitError) {
			throw limitError
		}

		if (timedOut) {
			throw new ExecutionError(
				'TIMEOUT',
				`Child exceeded ${opts.timeoutMs}ms timeout`,
				{
					stderrSnippet: stderrBuf || undefined,
					toolCallsUsed: toolCallCount
				}
			)
		}

		if (exitCode !== 0) {
			throw new ExecutionError(
				'SCRIPT_EXIT',
				`Child exited with code ${exitCode}`,
				{
					exitCode: exitCode ?? undefined,
					stderrSnippet: stderrBuf || undefined,
					toolCallsUsed: toolCallCount
				}
			)
		}

		return outputChunks.join('').trim()
	} finally {
		clearTimeout(timer)
		await cleanup(tmpFile)
	}
}

async function cleanup(path: string) {
	try {
		await unlink(path)
	} catch {
		/* best effort */
	}
}
