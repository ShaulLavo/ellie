export interface RetryOptions {
	/** Maximum number of retry attempts. Default: 3 */
	maxRetries?: number
	/** Initial delay in ms before the first retry. Default: 100 */
	initialDelay?: number
	/** Maximum delay in ms between retries. Default: 10_000 */
	maxDelay?: number
	/** Multiplier applied to the delay after each attempt. Default: 2 */
	multiplier?: number
	/** AbortSignal to cancel retries early. */
	signal?: AbortSignal
	/** Called after each failed attempt with the error and attempt number (1-indexed). */
	onRetry?: (error: unknown, attempt: number) => void
}

const defaults = {
	maxRetries: 3,
	initialDelay: 100,
	maxDelay: 10_000,
	multiplier: 2
} satisfies Required<
	Pick<
		RetryOptions,
		| 'maxRetries'
		| 'initialDelay'
		| 'maxDelay'
		| 'multiplier'
	>
>

/**
 * Retry an async function with exponential backoff and full jitter.
 *
 * ```ts
 * const data = await withRetry(() => fetchData(), { maxRetries: 5 })
 * ```
 */
export async function withRetry<T>(
	fn: (attempt: number) => T | Promise<T>,
	options: RetryOptions = {}
): Promise<T> {
	const {
		maxRetries = defaults.maxRetries,
		initialDelay = defaults.initialDelay,
		maxDelay = defaults.maxDelay,
		multiplier = defaults.multiplier,
		signal,
		onRetry
	} = options

	let delay = initialDelay

	for (let attempt = 0; ; attempt++) {
		try {
			return await fn(attempt)
		} catch (error) {
			if (signal?.aborted) throw signal.reason ?? error
			if (attempt >= maxRetries) throw error

			onRetry?.(error, attempt + 1)

			const jitter = Math.random() * delay
			const waitMs = Math.min(jitter, maxDelay)

			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, waitMs)

				signal?.addEventListener(
					'abort',
					() => {
						clearTimeout(timer)
						reject(signal.reason)
					},
					{ once: true }
				)
			})

			delay = Math.min(delay * multiplier, maxDelay)
		}
	}
}
