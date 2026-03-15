export interface RetryOptions {
	maxAttempts: number
	baseDelayMs: number
	maxDelayMs: number
	backoffMultiplier: number
	shouldRetry?: (error: unknown, attempt: number) => boolean
	onRetry?: (
		error: unknown,
		attempt: number,
		delayMs: number
	) => void
	signal?: AbortSignal
}

const DEFAULT_OPTIONS: RetryOptions = {
	maxAttempts: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
	backoffMultiplier: 2
}

/** delay = min(base * multiplier^(attempt-1), max) ± 20% jitter, respecting retryAfterMs */
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

/** Resolves to true if sleep completed, false if aborted. */
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
