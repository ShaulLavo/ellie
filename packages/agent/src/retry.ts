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

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Delay calculation
// ============================================================================

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
	// Exponential: base * multiplier^(attempt - 1)
	const exponential =
		options.baseDelayMs *
		Math.pow(options.backoffMultiplier, attempt - 1)

	// Cap at maxDelayMs
	let delay = Math.min(exponential, options.maxDelayMs)

	// Respect Retry-After if provided
	if (retryAfterMs !== undefined && retryAfterMs > 0) {
		delay = Math.max(delay, retryAfterMs)
	}

	// Cap again after Retry-After merge
	delay = Math.min(delay, options.maxDelayMs)

	// Add jitter: ±20%
	const jitter = delay * 0.2 * (2 * Math.random() - 1)
	delay = Math.max(0, delay + jitter)

	return Math.round(delay)
}

// ============================================================================
// Sleep with abort
// ============================================================================

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

// ============================================================================
// withRetry
// ============================================================================

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
		// Check abort before each attempt
		if (opts.signal?.aborted) {
			throw new DOMException('Retry aborted', 'AbortError')
		}

		try {
			return await fn()
		} catch (err) {
			lastError = err

			// Last attempt — don't retry, just throw
			if (attempt >= opts.maxAttempts) {
				break
			}

			// Check if caller wants to retry this error
			if (
				opts.shouldRetry &&
				!opts.shouldRetry(err, attempt)
			) {
				break
			}

			// Calculate delay for this retry
			// Extract retryAfterMs if the error has it
			let retryAfterMs: number | undefined
			if (
				err &&
				typeof err === 'object' &&
				'retryAfterMs' in err
			) {
				const val = (err as Record<string, unknown>)
					.retryAfterMs
				if (typeof val === 'number' && val > 0) {
					retryAfterMs = val
				}
			}

			const delayMs = calculateDelay(
				attempt,
				opts,
				retryAfterMs
			)

			// Notify caller of retry
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
