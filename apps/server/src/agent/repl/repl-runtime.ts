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
 */

import { ulid } from 'fast-ulid'

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

// ── Constants ───────────────────────────────────────────────────────────

const SENTINEL_PREFIX = '__ELLIE_REPL_SENTINEL_'
const COMMIT_MARKER = '__ELLIE_COMMIT__'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 262_144

// ── REPL Runtime ────────────────────────────────────────────────────────

export class ReplRuntime {
	readonly sessionId: string
	readonly #createdAt: number

	#proc: ReturnType<typeof Bun.spawn> | null = null
	#lastEvalAt: number | null = null
	#alive = false

	constructor(sessionId?: string) {
		this.sessionId = sessionId ?? ulid()
		this.#createdAt = Date.now()
	}

	/** Spawn the Bun REPL subprocess. Idempotent — safe to call if already alive. */
	async start(): Promise<void> {
		if (this.#alive && this.#proc) return

		this.#proc = Bun.spawn(['bun', 'repl'], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'inherit',
			env: {
				...process.env,
				// Inject the commit helper into the REPL environment
				NODE_OPTIONS: ''
			}
		})

		this.#alive = true

		// Inject the print/commit helper function into the REPL namespace
		const bootstrap = `
globalThis.${COMMIT_MARKER} = [];
globalThis.print = (...args) => {
  const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  globalThis.${COMMIT_MARKER}.push(text);
  console.log(text);
};
undefined;
`
		await this.#rawEval(bootstrap, 5_000)
	}

	/**
	 * Evaluate code in the persistent REPL.
	 *
	 * Only output from `print()` calls enters the committed
	 * result. Raw stdout/stderr is captured separately as artifacts.
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

		// Clear committed buffer, evaluate code, then dump committed output
		const wrappedCode = `
globalThis.${COMMIT_MARKER} = [];
(async () => {
${code}
})().then(() => {
  console.log(JSON.stringify({ __committed: globalThis.${COMMIT_MARKER} }));
}).catch((e) => {
  console.error(e?.message ?? String(e));
  console.log(JSON.stringify({ __committed: globalThis.${COMMIT_MARKER}, __error: e?.message ?? String(e) }));
});
`

		try {
			const rawOutput = await this.#rawEval(
				wrappedCode,
				timeoutMs
			)
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
			this.#proc.kill()
		} catch {
			// Already dead
		}

		this.#alive = false
		this.#proc = null
	}

	get alive(): boolean {
		return this.#alive
	}

	// ── Private ──────────────────────────────────────────────────────────

	/**
	 * Send raw code to the REPL stdin and capture output until sentinel.
	 */
	async #rawEval(
		code: string,
		timeoutMs: number
	): Promise<string> {
		if (!this.#proc?.stdin) {
			throw new Error('REPL stdin not available')
		}

		const sentinel = `${SENTINEL_PREFIX}${ulid()}`
		const payload = `${code}\nconsole.log("${sentinel}");\n`

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
	 */
	async #readUntilSentinel(
		sentinel: string,
		timeoutMs: number
	): Promise<string> {
		if (!this.#proc?.stdout) {
			throw new Error('REPL stdout not available')
		}

		const reader = this.#proc.stdout.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		let sawSentinel = false
		let streamEnded = false
		const deadline = Date.now() + timeoutMs

		try {
			while (Date.now() < deadline) {
				const remaining = deadline - Date.now()
				if (remaining <= 0) break

				const result = await Promise.race([
					reader.read(),
					new Promise<{ done: true; value: undefined }>(
						resolve =>
							setTimeout(
								() =>
									resolve({
										done: true,
										value: undefined
									}),
								remaining
							)
					)
				])

				if (result.done && !result.value) {
					// Timeout (setTimeout fired)
					break
				}

				if (result.value) {
					buffer += decoder.decode(result.value, {
						stream: true
					})
				}

				if (buffer.includes(sentinel)) {
					// Remove sentinel line and everything after
					const idx = buffer.indexOf(sentinel)
					buffer = buffer.slice(0, idx)
					sawSentinel = true
					break
				}

				if (result.done) {
					streamEnded = true
					break
				}
			}
		} finally {
			reader.releaseLock()
		}

		if (!sawSentinel) {
			if (streamEnded) {
				this.#alive = false
				throw new Error(
					'REPL process exited unexpectedly'
				)
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
