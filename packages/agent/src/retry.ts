/**
 * Retry engine — generic async retry with exponential backoff + jitter.
 *
 * Inspired by zclaw's retry pattern (3 attempts, 2s base, 10s max, exponential)
 * and openclaw's error classification + Retry-After header support.
 *
 * Design:
 * - Exponential backoff: delay = base * multiplier^(attempt-1)
 * - Random jitter: ±20% of calculated delay
 * - Retry-After header: use max(retryAfterMs, calculated) when available
 * - Abort signal: interrupt sleep via Promise.race
 * - Configurable shouldRetry predicate for caller-specific logic
 */

export interface RetryOptions {
	/** Maximum number of attempts (including the first). Default: 3. */
	maxAttempts: number
	/** Base delay in milliseconds. Default: 1000. */
	baseDelayMs: number
	/** Maximum delay in milliseconds. Default: 30000. */
	maxDelayMs: number
	/** Multiplier for exponential backoff. Default: 2. */
	backoffMultiplier: number
	/** Optional predicate to decide whether to retry. Return false to stop retrying. */
	shouldRetry?: (error: unknown, attempt: number) => boolean
	/** Called before each retry with the error, attempt number, and delay. */
	onRetry?: (
		error: unknown,
		attempt: number,
		delayMs: number
	) => void
	/** Abort signal to cancel retries. */
	signal?: AbortSignal
}

const DEFAULT_OPTIONS: RetryOptions = {
	maxAttempts: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
	backoffMultiplier: 2
}

/**
 * Calculate the delay for a given attempt.
 *
 * Formula: min(base * multiplier^(attempt-1), max) + jitter (±20%)
 * If retryAfterMs is provided, use max(retryAfterMs, calculated), still capped at maxDelayMs.
 *
 * @param attempt - 1-based attempt number (1 = first retry, not the initial call)
 * @param options - Retry options for delay parameters
 * @param retryAfterMs - Optional Retry-After delay from server (in ms)
 */
export function calculateDelay(
	attempt: number,
	options: RetryOptions,
	retryAfterMs?: number
): number {
	const exponential =
		options.baseDelayMs *
		Math.pow(options.backoffMultiplier, attempt - 1)

	let delay = Math.min(exponential, options.maxDelayMs)

	if (retryAfterMs !== undefined && retryAfterMs > 0) {
		delay = Math.max(delay, retryAfterMs)
	}

	delay = Math.min(delay, options.maxDelayMs)

	const jitter = delay * 0.2 * (2 * Math.random() - 1)
	delay = Math.max(0, delay + jitter)

	return Math.round(delay)
}

/**
 * Sleep for the given duration, interruptible by abort signal.
 * Resolves to true if sleep completed, false if aborted.
 */
export function abortableSleep(
	ms: number,
	signal?: AbortSignal
): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false)
	if (ms <= 0) return Promise.resolve(true)

	return new Promise<boolean>(resolve => {
		let timer: ReturnType<typeof setTimeout> | undefined
		let abortHandler: (() => void) | undefined

		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer)
			if (abortHandler && signal) {
				signal.removeEventListener('abort', abortHandler)
			}
		}

		timer = setTimeout(() => {
			cleanup()
			resolve(true)
		}, ms)

		if (signal) {
			abortHandler = () => {
				cleanup()
				resolve(false)
			}
			signal.addEventListener('abort', abortHandler, {
				once: true
			})
		}
	})
}

/**
 * Extract retryAfterMs from an error object, if present and valid.
 */
function extractRetryAfterMs(
	err: unknown
): number | undefined {
	if (
		!err ||
		typeof err !== 'object' ||
		!('retryAfterMs' in err)
	) {
		return undefined
	}
	const val = (err as Record<string, unknown>).retryAfterMs
	return typeof val === 'number' && val > 0
		? val
		: undefined
}

/**
 * Execute an async function with retry on failure.
 *
 * @param fn - The async function to execute. Called on each attempt.
 * @param options - Partial retry options (defaults filled in).
 * @returns The result of the first successful execution.
 * @throws The last error if all attempts fail or if shouldRetry returns false.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	options?: Partial<RetryOptions>
): Promise<T> {
	const opts: RetryOptions = {
		...DEFAULT_OPTIONS,
		...options
	}

	if (opts.maxAttempts < 1) {
		throw new Error('maxAttempts must be >= 1')
	}

	let lastError: unknown

	for (
		let attempt = 1;
		attempt <= opts.maxAttempts;
		attempt++
	) {
		if (opts.signal?.aborted) {
			throw new DOMException('Retry aborted', 'AbortError')
		}

		try {
			return await fn()
		} catch (err) {
			lastError = err

			if (attempt >= opts.maxAttempts) {
				break
			}

			if (
				opts.shouldRetry &&
				!opts.shouldRetry(err, attempt)
			) {
				break
			}

			const delayMs = calculateDelay(
				attempt,
				opts,
				extractRetryAfterMs(err)
			)

			opts.onRetry?.(err, attempt, delayMs)

			// Sleep (interruptible by abort)
			const sleptFully = await abortableSleep(
				delayMs,
				opts.signal
			)
			if (!sleptFully) {
				throw new DOMException(
					'Retry aborted during backoff',
					'AbortError'
				)
			}
		}
	}

	throw lastError
}
