export class TimeoutError extends Error {
	constructor(ms: number) {
		super(`Timed out after ${ms}ms`)
		this.name = 'TimeoutError'
	}
}

/**
 * Race a promise against a timeout. Rejects with `TimeoutError` if the
 * timeout fires first.
 *
 * ```ts
 * const data = await withTimeout(fetchData(), 5000)
 * ```
 *
 * Also accepts a function, which lets you use the internal `AbortSignal`:
 *
 * ```ts
 * const data = await withTimeout(
 *   (signal) => fetch(url, { signal }),
 *   5000,
 * )
 * ```
 */
export async function withTimeout<T>(
	input: Promise<T> | ((signal: AbortSignal) => Promise<T>),
	ms: number
): Promise<T> {
	const controller = new AbortController()

	const promise = typeof input === 'function' ? input(controller.signal) : input

	let timer: ReturnType<typeof setTimeout> | undefined

	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort()
			reject(new TimeoutError(ms))
		}, ms)
	})

	try {
		return await Promise.race([promise, timeout])
	} finally {
		clearTimeout(timer)
	}
}
