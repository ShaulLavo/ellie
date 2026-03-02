import type { Subprocess } from 'bun'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlink, writeFile } from 'node:fs/promises'
import { ulid } from 'fast-ulid'
import { buildScript } from './ptc-runtime'
import {
	PTC_DEFAULTS,
	PTCExecutionError,
	type ExecutePTCOptions,
	type ToolClient,
	type ToolDefinition
} from './types'

interface ToolCallMessage {
	__ptc_call__: true
	id: string
	tool: string
	args: Record<string, unknown>
}

function isToolCall(msg: unknown): msg is ToolCallMessage {
	if (typeof msg !== 'object' || msg === null) return false
	const obj = msg as Record<string, unknown>
	return (
		obj.__ptc_call__ === true &&
		typeof obj.id === 'string' &&
		typeof obj.tool === 'string' &&
		typeof obj.args === 'object' &&
		obj.args !== null
	)
}

/**
 * Execute agent code in an isolated Bun child process, bridging tool
 * calls over JSONL stdio.
 */
export async function executePTC(
	agentCode: string,
	tools: ToolDefinition[],
	toolClient: ToolClient,
	options?: ExecutePTCOptions
): Promise<string> {
	const opts = {
		timeoutMs: options?.timeoutMs ?? PTC_DEFAULTS.timeoutMs,
		maxToolCalls:
			options?.maxToolCalls ?? PTC_DEFAULTS.maxToolCalls,
		maxOutputBytes:
			options?.maxOutputBytes ??
			PTC_DEFAULTS.maxOutputBytes,
		captureStderrBytes:
			options?.captureStderrBytes ??
			PTC_DEFAULTS.captureStderrBytes,
		tempDir: options?.tempDir ?? tmpdir()
	}

	// ── 1. Build & write temp script ────────────────────────────────
	const script = await buildScript(agentCode, tools)
	const tmpFile = join(opts.tempDir, `ptc-${ulid()}.ts`)
	await writeFile(tmpFile, script, 'utf-8')

	// ── 2. Spawn child ──────────────────────────────────────────────
	let child: Subprocess<'pipe', 'pipe', 'pipe'>
	try {
		child = Bun.spawn([process.execPath, 'run', tmpFile], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env: {}
		}) as Subprocess<'pipe', 'pipe', 'pipe'>
	} catch (err) {
		await cleanup(tmpFile)
		throw new PTCExecutionError(
			'SPAWN_FAILED',
			'Failed to spawn child process',
			{
				cause: err
			}
		)
	}

	// ── 3. Run protocol loop ────────────────────────────────────────
	let toolCallCount = 0
	let outputBytes = 0
	const outputChunks: string[] = []
	let stderrBuf = ''
	let stderrBytes = 0
	let timedOut = false
	// Track limit errors so they take priority over SCRIPT_EXIT
	let limitError: PTCExecutionError | null = null

	const timer = setTimeout(() => {
		timedOut = true
		child.kill()
	}, opts.timeoutMs)

	try {
		// Stderr collector (bounded)
		const stderrReader = child.stderr.getReader()
		const stderrDecoder = new TextDecoder()
		const stderrDrain = (async () => {
			try {
				while (true) {
					const { done, value } = await stderrReader.read()
					if (done) break
					if (stderrBytes >= opts.captureStderrBytes)
						continue
					const chunk = stderrDecoder.decode(value, {
						stream: true
					})
					stderrBuf += chunk
					stderrBytes += value.byteLength
				}
			} catch {
				/* stream closed */
			}
		})()

		// Stdout protocol reader
		const stdoutReader = child.stdout.getReader()
		const stdoutDecoder = new TextDecoder()
		let stdoutBuf = ''

		const stdoutDrain = (async () => {
			try {
				while (true) {
					if (limitError) break
					const { done, value } = await stdoutReader.read()
					if (done) break
					stdoutBuf += stdoutDecoder.decode(value, {
						stream: true
					})

					let nl: number
					while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
						const line = stdoutBuf.slice(0, nl)
						stdoutBuf = stdoutBuf.slice(nl + 1)
						await processLine(line)
						if (limitError) return
					}
				}
				// Flush remaining partial line
				if (!limitError && stdoutBuf.trim()) {
					await processLine(stdoutBuf)
				}
			} catch {
				/* stream closed */
			}
		})()

		async function processLine(line: string) {
			const trimmed = line.trim()
			if (!trimmed) return

			// Try to parse as protocol message
			let parsed: unknown
			try {
				parsed = JSON.parse(trimmed)
			} catch {
				// Not JSON → treat as final output
				appendOutput(line)
				return
			}

			if (isToolCall(parsed)) {
				toolCallCount++
				if (toolCallCount > opts.maxToolCalls) {
					limitError = new PTCExecutionError(
						'SCRIPT_RUNTIME',
						`Exceeded max tool calls (${opts.maxToolCalls})`,
						{ toolCallsUsed: toolCallCount }
					)
					child.kill()
					return
				}
				try {
					const result = await toolClient.callTool(
						parsed.tool,
						parsed.args
					)
					const response = JSON.stringify({
						__ptc_result__: true,
						id: parsed.id,
						result
					})
					child.stdin.write(response + '\n')
					await child.stdin.flush()
				} catch (err) {
					const errMsg =
						err instanceof Error ? err.message : String(err)
					const response = JSON.stringify({
						__ptc_result__: true,
						id: parsed.id,
						error: errMsg
					})
					child.stdin.write(response + '\n')
					await child.stdin.flush()
				}
			} else {
				// Valid JSON but not a tool call → final output
				appendOutput(line)
			}
		}

		function appendOutput(line: string) {
			const bytes = new TextEncoder().encode(
				line + '\n'
			).length
			outputBytes += bytes
			if (outputBytes > opts.maxOutputBytes) {
				limitError = new PTCExecutionError(
					'OUTPUT_LIMIT',
					`Output exceeded ${opts.maxOutputBytes} bytes`,
					{ outputBytes }
				)
				child.kill()
				return
			}
			outputChunks.push(line)
		}

		// Wait for child to exit and streams to drain
		const exitCode = await child.exited
		await Promise.all([stdoutDrain, stderrDrain])

		// Priority order: limit errors > timeout > non-zero exit
		if (limitError) {
			throw limitError
		}

		if (timedOut) {
			throw new PTCExecutionError(
				'TIMEOUT',
				`Child exceeded ${opts.timeoutMs}ms timeout`,
				{
					stderrSnippet: stderrBuf || undefined,
					toolCallsUsed: toolCallCount
				}
			)
		}

		if (exitCode !== 0) {
			throw new PTCExecutionError(
				'SCRIPT_EXIT',
				`Child exited with code ${exitCode}`,
				{
					exitCode: exitCode ?? undefined,
					stderrSnippet: stderrBuf || undefined,
					toolCallsUsed: toolCallCount
				}
			)
		}

		return outputChunks.join('\n')
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
