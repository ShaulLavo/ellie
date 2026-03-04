/**
 * REPL runtime — manages a persistent Bun REPL subprocess.
 *
 * Provides a long-lived TypeScript execution environment where
 * variables, imports, and function definitions persist across
 * consecutive `evaluate()` calls within the same session.
 *
 * Communication protocol:
 *   1. Write code block to stdin, terminated by a sentinel marker.
 *   2. Read stdout/stderr until sentinel echo appears.
 *   3. Parse structured output (committed text vs raw artifacts).
 *
 * Tool access (optional):
 *   When constructed with ToolClient + ToolDefinition[], the REPL
 *   subprocess gets IPC-bridged tool functions (same as script_exec).
 *   Tools are callable as `await toolName({ arg: value })`.
 */

import { ulid } from 'fast-ulid'
import {
	buildReplBootstrap,
	type ToolClient,
	type ToolDefinition
} from '@ellie/code-exec'

// ── Types ───────────────────────────────────────────────────────────────

export interface ReplEvalResult {
	/** Committed output (from print/commit calls). Injected into model context. */
	committed: string
	/** Raw stdout/stderr. Stored as artifacts, NOT injected into context. */
	raw: string
	/** Whether execution produced an error. */
	isError: boolean
	/** Error message if isError is true. */
	errorMessage?: string
	/** Wall-clock execution time in ms. */
	elapsedMs: number
}

export interface ReplSessionInfo {
	sessionId: string
	pid: number | null
	alive: boolean
	createdAt: number
	lastEvalAt: number | null
}

export interface ReplToolConfig {
	/** Tool definitions for generating wrapper functions. */
	tools: ToolDefinition[]
	/** Client that executes tool calls on behalf of the child. */
	client: ToolClient
	/** Max number of tool calls per evaluate() (default: 64). */
	maxToolCalls?: number
}

// ── Constants ───────────────────────────────────────────────────────────

const SENTINEL_PREFIX = '__ELLIE_REPL_SENTINEL_'
const COMMIT_MARKER = '__ELLIE_COMMIT__'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 262_144
const DEFAULT_MAX_TOOL_CALLS = 64

// ── IPC protocol (matches child-runtime.ts / executor.ts) ───────────────

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

// ── REPL Runtime ────────────────────────────────────────────────────────

/** Bun.spawn generics vary by stdio config — define the shape we need. */
type ReplProc = {
	pid: number
	stdin: {
		write(data: string | Uint8Array): number
		flush(): void
	}
	stdout: ReadableStream<Uint8Array>
	send(msg: unknown): void
	kill(): void
	exited: Promise<number | null>
}

export class ReplRuntime {
	readonly sessionId: string
	readonly #createdAt: number
	readonly #toolConfig: ReplToolConfig | null

	#proc: ReplProc | null = null
	#lastEvalAt: number | null = null
	#alive = false
	#toolCallCount = 0
	#reader: ReadableStreamDefaultReader<Uint8Array> | null =
		null
	#residualBuffer = ''
	#decoder = new TextDecoder()

	constructor(
		sessionId?: string,
		toolConfig?: ReplToolConfig
	) {
		this.sessionId = sessionId ?? ulid()
		this.#createdAt = Date.now()
		this.#toolConfig = toolConfig ?? null
	}

	/** Spawn the Bun REPL subprocess. Idempotent — safe to call if already alive. */
	async start(): Promise<void> {
		if (this.#alive && this.#proc) return

		const maxToolCalls =
			this.#toolConfig?.maxToolCalls ??
			DEFAULT_MAX_TOOL_CALLS
		const toolClient = this.#toolConfig?.client

		// eslint-disable-next-line prefer-const -- assigned by Bun.spawn, used in ipc closure
		let proc: ReplProc | null

		proc = Bun.spawn(['bun', 'repl'], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'inherit',
			env: {
				...process.env,
				NODE_OPTIONS: ''
			},
			// IPC handler — bridges tool calls from the child
			// back to the parent-side ToolClient.
			ipc: message => {
				if (!isToolCall(message)) return
				if (!toolClient) return

				this.#toolCallCount++
				if (this.#toolCallCount > maxToolCalls) {
					try {
						proc!.send({
							__ce_result__: true,
							id: message.id,
							error: `Exceeded max tool calls (${maxToolCalls})`
						})
					} catch {
						/* child exited */
					}
					return
				}

				toolClient
					.callTool(message.tool, message.args)
					.then(result => {
						try {
							proc!.send({
								__ce_result__: true,
								id: message.id,
								result
							})
						} catch {
							/* child exited */
						}
					})
					.catch(err => {
						const errMsg =
							err instanceof Error
								? err.message
								: String(err)
						try {
							proc!.send({
								__ce_result__: true,
								id: message.id,
								error: errMsg
							})
						} catch {
							/* child exited */
						}
					})
			}
		}) as unknown as ReplProc | null

		this.#proc = proc

		this.#alive = true

		// ── Bootstrap phase ──────────────────────────────────

		try {
			// 1. IPC runtime + tool wrappers (if tools configured)
			if (
				this.#toolConfig &&
				this.#toolConfig.tools.length > 0
			) {
				const ipcBootstrap = await buildReplBootstrap(
					this.#toolConfig.tools
				)
				await this.#rawEval(ipcBootstrap, 10_000)
			}

			// 2. print/commit helper + stderr error capture
			const printBootstrap = `
globalThis.${COMMIT_MARKER} = [];
globalThis.__ELLIE_LAST_ERROR__ = null;
globalThis.print = (...args) => {
  const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  globalThis.${COMMIT_MARKER}.push(text);
  console.log(text);
};
var __origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function(...args) {
  globalThis.__ELLIE_LAST_ERROR__ = String(args[0]).trim();
  return __origStderrWrite.apply(process.stderr, args);
};
undefined;
`
			await this.#rawEval(printBootstrap, 5_000)
		} catch (err) {
			// Bootstrap failed — rollback: kill the process and reset state
			await this.teardown()
			throw err
		}
	}

	/**
	 * Evaluate code in the persistent REPL.
	 *
	 * Only output from `print()` calls enters the committed
	 * result. Raw stdout/stderr is captured separately as artifacts.
	 *
	 * Code is sent directly to the REPL top-level (no IIFE wrapper)
	 * so variables declared with let/const/var persist across calls.
	 * If a line throws, the REPL catches it and continues — the
	 * committed dump and sentinel still execute.
	 */
	async evaluate(
		code: string,
		timeoutMs = DEFAULT_TIMEOUT_MS
	): Promise<ReplEvalResult> {
		if (!this.#alive || !this.#proc) {
			throw new Error(
				'REPL not started. Call start() first.'
			)
		}
		if (!this.#proc.stdin) {
			throw new Error('REPL stdin not available')
		}

		const startMs = Date.now()
		const sentinel = `${SENTINEL_PREFIX}${ulid()}`

		// Reset per-evaluate tool call counter
		this.#toolCallCount = 0

		// Send code directly to the REPL top level — no IIFE — so
		// let/const/var declarations persist across evaluate() calls.
		// The REPL catches per-line errors and continues, so the
		// committed dump + sentinel always execute.
		// __ELLIE_LAST_ERROR__ is set by the stderr hook (see bootstrap)
		// whenever the REPL catches a runtime error.
		const wrappedCode = `globalThis.${COMMIT_MARKER} = [];
globalThis.__ELLIE_LAST_ERROR__ = null;
${code}
process.stdout.write(JSON.stringify({ __committed: globalThis.${COMMIT_MARKER}, __error: globalThis.__ELLIE_LAST_ERROR__ }) + "\\n${sentinel}\\n");
`

		try {
			this.#proc.stdin.write(wrappedCode + '\n')
			this.#proc.stdin.flush()

			let rawOutput = await this.#readUntilSentinel(
				sentinel,
				timeoutMs
			)

			// Enforce output size cap
			if (rawOutput.length > MAX_OUTPUT_BYTES) {
				rawOutput =
					rawOutput.slice(0, MAX_OUTPUT_BYTES) +
					'\n...(output truncated)'
			}

			const elapsedMs = Date.now() - startMs
			this.#lastEvalAt = Date.now()

			return this.#parseOutput(rawOutput, elapsedMs)
		} catch (err) {
			const elapsedMs = Date.now() - startMs
			this.#lastEvalAt = Date.now()

			const msg =
				err instanceof Error ? err.message : String(err)
			return {
				committed: '',
				raw: msg,
				isError: true,
				errorMessage: msg,
				elapsedMs
			}
		}
	}

	/** Get session info. */
	info(): ReplSessionInfo {
		return {
			sessionId: this.sessionId,
			pid: this.#proc?.pid ?? null,
			alive: this.#alive,
			createdAt: this.#createdAt,
			lastEvalAt: this.#lastEvalAt
		}
	}

	/** Kill the subprocess and mark as dead. */
	async teardown(): Promise<void> {
		if (!this.#proc) return

		try {
			if (this.#reader) {
				this.#reader.releaseLock()
				this.#reader = null
			}
			this.#proc.kill()
		} catch {
			// Already dead
		}

		this.#alive = false
		this.#proc = null
		this.#residualBuffer = ''
	}

	get alive(): boolean {
		return this.#alive
	}

	// ── Private ──────────────────────────────────────────────────────────

	/**
	 * Send raw code to the REPL stdin and capture output until sentinel.
	 * Used for synchronous bootstrap code where sentinel-after is safe.
	 */
	async #rawEval(
		code: string,
		timeoutMs: number
	): Promise<string> {
		if (!this.#proc?.stdin) {
			throw new Error('REPL stdin not available')
		}

		const sentinel = `${SENTINEL_PREFIX}${ulid()}`
		const payload = `${code}\nprocess.stdout.write("${sentinel}\\n");\n`

		this.#proc.stdin.write(payload)
		this.#proc.stdin.flush()

		// Read stdout until sentinel appears or timeout
		const output = await this.#readUntilSentinel(
			sentinel,
			timeoutMs
		)

		// Enforce output size cap
		if (output.length > MAX_OUTPUT_BYTES) {
			return (
				output.slice(0, MAX_OUTPUT_BYTES) +
				'\n...(output truncated)'
			)
		}

		return output
	}

	/**
	 * Read from stdout until the sentinel line appears.
	 *
	 * Uses a persistent reader and residual buffer so data produced
	 * between evaluations (REPL prompts, return-value echoes) doesn't
	 * bleed into the wrong evaluation's output.
	 */
	async #readUntilSentinel(
		sentinel: string,
		timeoutMs: number
	): Promise<string> {
		if (!this.#proc?.stdout) {
			throw new Error('REPL stdout not available')
		}

		// Reuse persistent reader — creating a new one each time
		// loses buffered data sitting in the stream.
		if (!this.#reader) {
			this.#reader = this.#proc.stdout.getReader()
		}

		// Start with any leftover data from the previous read
		let buffer = this.#residualBuffer
		this.#residualBuffer = ''

		let sawSentinel = false
		let streamEnded = false
		const deadline = Date.now() + timeoutMs

		// Check residual buffer first before reading more
		if (buffer.includes(sentinel)) {
			const idx = buffer.indexOf(sentinel)
			const sentinelLineEnd = buffer.indexOf('\n', idx)
			const before = buffer.slice(0, idx)
			this.#residualBuffer =
				sentinelLineEnd !== -1
					? buffer.slice(sentinelLineEnd + 1)
					: ''
			return before.trim()
		}

		while (Date.now() < deadline) {
			const remaining = deadline - Date.now()
			if (remaining <= 0) break

			const result = await Promise.race([
				this.#reader.read(),
				new Promise<{
					done: true
					value: undefined
					timeout: true
				}>(resolve =>
					setTimeout(
						() =>
							resolve({
								done: true,
								value: undefined,
								timeout: true
							}),
						remaining
					)
				)
			])

			if ('timeout' in result) {
				// Timeout (setTimeout fired)
				break
			}

			if (result.value) {
				buffer += this.#decoder.decode(result.value, {
					stream: true
				})
			}

			if (buffer.includes(sentinel)) {
				const idx = buffer.indexOf(sentinel)
				const sentinelLineEnd = buffer.indexOf('\n', idx)
				const before = buffer.slice(0, idx)
				// Save anything after the sentinel line
				// for the next evaluation
				this.#residualBuffer =
					sentinelLineEnd !== -1
						? buffer.slice(sentinelLineEnd + 1)
						: ''
				sawSentinel = true
				buffer = before
				break
			}

			if (result.done) {
				streamEnded = true
				break
			}
		}

		if (!sawSentinel) {
			if (streamEnded) {
				this.#alive = false
				this.#reader = null
				throw new Error('REPL process exited unexpectedly')
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`REPL evaluation timed out after ${timeoutMs}ms`
				)
			}
		}

		return buffer.trim()
	}

	/**
	 * Parse raw REPL output into committed + raw parts.
	 */
	#parseOutput(
		rawOutput: string,
		elapsedMs: number
	): ReplEvalResult {
		// Look for the JSON committed output at the end
		const lines = rawOutput.split('\n')
		let committed = ''
		let errorMessage: string | undefined
		let isError = false
		const rawLines: string[] = []

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as {
					__committed?: string[]
					__error?: string
				}
				if (
					parsed.__committed &&
					Array.isArray(parsed.__committed)
				) {
					committed = parsed.__committed.join('\n')
					if (parsed.__error) {
						isError = true
						errorMessage = parsed.__error
					}
					continue
				}
			} catch {
				// Not JSON — treat as raw output
			}
			rawLines.push(line)
		}

		return {
			committed,
			raw: rawLines.join('\n'),
			isError,
			errorMessage,
			elapsedMs
		}
	}
}
