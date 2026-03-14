/**
 * REPL runtime — manages a persistent Bun REPL subprocess.
 *
 * Provides a long-lived TypeScript execution environment where
 * variables, imports, and function definitions persist across
 * consecutive `evaluate()` calls within the same session.
 *
 * Communication:
 *   stdin/stdout sentinel protocol for code evaluation.
 *   localhost HTTP server for tool calls (fetch-based, no IPC).
 *
 * On timeout the subprocess is killed and auto-restarts on next call.
 */

import { ulid } from 'fast-ulid'
import type { AgentTool } from '@ellie/agent'
import type {
	BlobSink,
	TraceRecorder,
	TraceScope
} from '@ellie/trace'
import { createChildScope } from '@ellie/trace'

// ── Types ───────────────────────────────────────────────────────────────

/** Trace dependencies for recording nested tool calls in the REPL. */
export interface ReplTraceDeps {
	recorder: TraceRecorder
	/** Blob sink for artifact storage. */
	blobSink?: BlobSink
	/** Returns the active REPL scope — set per-invocation by traced-repl.ts. */
	getParentScope: () => TraceScope | undefined
}

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

// ── Constants ───────────────────────────────────────────────────────────

const SENTINEL_PREFIX = '__ELLIE_REPL_SENTINEL_'
const COMMIT_MARKER = '__ELLIE_COMMIT__'
const DEFAULT_TIMEOUT_MS = 180_000
const MAX_OUTPUT_BYTES = 262_144

// ── Helpers ─────────────────────────────────────────────────────────────

type ReplProc = {
	pid: number
	stdin: {
		write(data: string | Uint8Array): number
		flush(): void
	}
	stdout: ReadableStream<Uint8Array>
	kill(): void
	exited: Promise<number | null>
}

/**
 * Parse a line as a JSON committed-output envelope.
 * Returns committed text + optional error, or null if not a committed line.
 */
function parseCommittedLine(
	line: string
): { committed: string; error?: string } | null {
	let parsed: { __committed?: string[]; __error?: string }
	try {
		parsed = JSON.parse(line) as typeof parsed
	} catch {
		return null
	}
	if (
		parsed === null ||
		typeof parsed !== 'object' ||
		!parsed.__committed ||
		!Array.isArray(parsed.__committed)
	) {
		return null
	}
	return {
		committed: parsed.__committed.join('\n'),
		error: parsed.__error
	}
}

/**
 * Generate the bootstrap code injected into the REPL via stdin.
 * Sets up fetch-based tool wrappers + print() helper.
 */
function generateBootstrap(
	tools: AgentTool[],
	toolUrl: string
): string {
	const callTool = `
async function __callTool(name, args) {
  const r = await fetch(${JSON.stringify(toolUrl)}, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: name, args: args ?? {} })
  });
  const d = await r.json();
  if (d.error) throw new Error(String(d.error));
  const raw = d.result;
  if (raw && typeof raw === "object" && "content" in raw && Array.isArray(raw.content)) {
    return raw.content.map(c => typeof c.text === "string" ? c.text : "").join("");
  }
  return raw;
}
`
	const wrappers = tools
		.map(
			t =>
				`async function ${t.name}(args) { return __callTool(${JSON.stringify(t.name)}, args) }`
		)
		.join('\n')

	const printHelper = `
globalThis.${COMMIT_MARKER} = [];
globalThis.__ELLIE_LAST_ERROR__ = null;
globalThis.print = (...args) => {
  const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  globalThis.${COMMIT_MARKER}.push(text);
  console.log(text);
};
var __origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function(...args) {
  globalThis.__ELLIE_LAST_ERROR__ = String(args[0]).trim();
  return __origStderrWrite.apply(process.stderr, args);
};
`
	return `${callTool}\n${wrappers}\n${printHelper}\nundefined;\n`
}

// ── REPL Runtime ────────────────────────────────────────────────────────

export class ReplRuntime {
	readonly sessionId: string
	readonly #createdAt: number
	readonly #tools: AgentTool[]
	readonly #traceDeps?: ReplTraceDeps

	#proc: ReplProc | null = null
	#server: ReturnType<typeof Bun.serve> | null = null
	#lastEvalAt: number | null = null
	#alive = false
	#reader: ReadableStreamDefaultReader<Uint8Array> | null =
		null
	#residualBuffer = ''
	#decoder = new TextDecoder()

	constructor(
		sessionId?: string,
		tools?: AgentTool[],
		traceDeps?: ReplTraceDeps
	) {
		this.sessionId = sessionId ?? ulid()
		this.#createdAt = Date.now()
		this.#tools = tools ?? []
		this.#traceDeps = traceDeps
	}

	/** Spawn the REPL subprocess + tool server. Idempotent. */
	async start(): Promise<void> {
		if (this.#alive && this.#proc) return

		// 1. Start HTTP tool server (if tools provided)
		let toolUrl = ''
		if (this.#tools.length > 0) {
			const toolMap = new Map(
				this.#tools.map(t => [t.name, t])
			)
			this.#server = Bun.serve({
				port: 0,
				hostname: '127.0.0.1',
				fetch: async req => {
					try {
						const body = (await req.json()) as {
							tool: string
							args: Record<string, unknown>
						}
						const tool = toolMap.get(body.tool)
						if (!tool) {
							return Response.json({
								error: `Unknown tool: ${body.tool}`
							})
						}

						const toolCallId = `repl-${ulid()}`
						const parentScope =
							this.#traceDeps?.getParentScope()

						// Traced path — record tool.start/tool.end as children of the REPL span
						if (this.#traceDeps && parentScope) {
							const scope = createChildScope(parentScope)
							const startedAt = Date.now()

							this.#traceDeps.recorder.record(
								scope,
								'tool.start',
								'tool',
								{
									toolName: body.tool,
									toolCallId,
									args: body.args,
									context: 'repl'
								}
							)

							try {
								const result = await tool.execute(
									toolCallId,
									body.args
								)
								this.#traceDeps.recorder.record(
									scope,
									'tool.end',
									'tool',
									{
										toolName: body.tool,
										toolCallId,
										isError: false,
										elapsedMs: Date.now() - startedAt,
										context: 'repl'
									}
								)
								return Response.json({
									result
								})
							} catch (err) {
								const msg =
									err instanceof Error
										? err.message
										: String(err)
								this.#traceDeps.recorder.record(
									scope,
									'tool.end',
									'tool',
									{
										toolName: body.tool,
										toolCallId,
										isError: true,
										error: msg,
										elapsedMs: Date.now() - startedAt,
										context: 'repl'
									}
								)
								return Response.json({
									error: msg
								})
							}
						}

						// Untraced path
						const result = await tool.execute(
							toolCallId,
							body.args
						)
						return Response.json({ result })
					} catch (err) {
						const msg =
							err instanceof Error
								? err.message
								: String(err)
						return Response.json({ error: msg })
					}
				}
			})
			toolUrl = `http://127.0.0.1:${this.#server.port}`
		}

		// 2. Spawn REPL (no IPC needed)
		const proc = Bun.spawn(['bun', 'repl'], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'inherit',
			env: {
				...process.env,
				NODE_OPTIONS: ''
			}
		}) as unknown as ReplProc | null

		this.#proc = proc
		this.#alive = true

		// 3. Bootstrap: inject tool wrappers + print helper
		try {
			const bootstrap = generateBootstrap(
				this.#tools,
				toolUrl
			)
			await this.#rawEval(bootstrap, 10_000)
		} catch (err) {
			await this.teardown()
			throw err
		}
	}

	/**
	 * Evaluate code in the persistent REPL.
	 *
	 * Only `print()` output enters the committed result.
	 * Raw stdout/stderr is captured separately as artifacts.
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

		const startMs = Date.now()
		const sentinel = `${SENTINEL_PREFIX}${ulid()}`

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

	/** Kill the subprocess and tool server. */
	async teardown(): Promise<void> {
		if (!this.#proc && !this.#server) return

		try {
			this.#reader?.releaseLock()
		} catch {
			/* already released */
		}
		this.#reader = null

		try {
			this.#proc?.kill()
		} catch {
			/* already dead */
		}
		this.#proc = null

		try {
			this.#server?.stop()
		} catch {
			/* already stopped */
		}
		this.#server = null

		this.#alive = false
		this.#residualBuffer = ''
	}

	get alive(): boolean {
		return this.#alive
	}

	// ── Private ──────────────────────────────────────────────────────────

	/**
	 * Send raw code to stdin and capture output until sentinel.
	 * Used for bootstrap where sentinel-after is safe.
	 */
	async #rawEval(
		code: string,
		timeoutMs: number
	): Promise<string> {
		if (!this.#proc?.stdin) {
			throw new Error('REPL stdin not available')
		}

		const sentinel = `${SENTINEL_PREFIX}${ulid()}`
		const payload = `${code}\nprocess.stdout.write("\\n${sentinel}\\n");\n`

		this.#proc.stdin.write(payload)
		this.#proc.stdin.flush()

		const output = await this.#readUntilSentinel(
			sentinel,
			timeoutMs
		)

		if (output.length > MAX_OUTPUT_BYTES) {
			return (
				output.slice(0, MAX_OUTPUT_BYTES) +
				'\n...(output truncated)'
			)
		}
		return output
	}

	/**
	 * Read stdout until the sentinel line appears.
	 *
	 * On timeout: kills the process so session_exec auto-restarts
	 * on the next call (no corrupted state).
	 */
	async #readUntilSentinel(
		sentinel: string,
		timeoutMs: number
	): Promise<string> {
		if (!this.#proc?.stdout) {
			throw new Error('REPL stdout not available')
		}

		if (!this.#reader) {
			this.#reader = this.#proc.stdout.getReader()
		}

		let buffer = this.#residualBuffer
		this.#residualBuffer = ''

		let sawSentinel = false
		let streamEnded = false
		const deadline = Date.now() + timeoutMs

		// Search for \n + sentinel to avoid matching the REPL's
		// character-by-character echo of source code.
		const sentinelNL = '\n' + sentinel

		// Check residual buffer first
		if (buffer.includes(sentinelNL)) {
			const idx = buffer.indexOf(sentinelNL)
			const sentinelLineEnd = buffer.indexOf(
				'\n',
				idx + sentinelNL.length
			)
			this.#residualBuffer =
				sentinelLineEnd !== -1
					? buffer.slice(sentinelLineEnd + 1)
					: ''
			return buffer.slice(0, idx).trim()
		}

		while (Date.now() < deadline) {
			const remaining = deadline - Date.now()
			if (remaining <= 0) break

			const readPromise = this.#reader.read()
			const result = await Promise.race([
				readPromise,
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
				// Kill the process — it's stuck. Session will
				// auto-restart on next evaluate() call.
				readPromise.catch(() => {})
				await this.teardown()
				break
			}

			if (result.value) {
				buffer += this.#decoder.decode(result.value, {
					stream: true
				})
			}

			if (buffer.includes(sentinelNL)) {
				const idx = buffer.indexOf(sentinelNL)
				const sentinelLineEnd = buffer.indexOf(
					'\n',
					idx + sentinelNL.length
				)
				this.#residualBuffer =
					sentinelLineEnd !== -1
						? buffer.slice(sentinelLineEnd + 1)
						: ''
				sawSentinel = true
				buffer = buffer.slice(0, idx)
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
			if (Date.now() >= deadline || !this.#alive) {
				throw new Error(
					`REPL evaluation timed out after ${timeoutMs}ms`
				)
			}
		}

		return buffer.trim()
	}

	/** Parse raw REPL output into committed + raw parts. */
	#parseOutput(
		rawOutput: string,
		elapsedMs: number
	): ReplEvalResult {
		const lines = rawOutput.split('\n')
		let committed = ''
		let errorMessage: string | undefined
		let isError = false
		const rawLines: string[] = []

		for (const line of lines) {
			const envelope = parseCommittedLine(line)
			if (!envelope) {
				rawLines.push(line)
				continue
			}
			committed = envelope.committed
			if (envelope.error) {
				isError = true
				errorMessage = envelope.error
			}
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
