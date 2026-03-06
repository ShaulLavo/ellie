/**
 * Push-based async iterable for streaming events.
 *
 * Producers push events via `push()` and signal completion via `end()`.
 * Consumers iterate with `for await...of` and can await the final result via `result()`.
 */
export class EventStream<
	T,
	R = T
> implements AsyncIterable<T> {
	private queue: T[] = []
	private readIndex = 0
	private resolve:
		| ((value: IteratorResult<T>) => void)
		| null = null
	private done = false
	private finalResult: R | undefined
	private resultResolve: ((result: R) => void) | null = null
	private resultReject: ((reason: Error) => void) | null =
		null
	private resultPromise: Promise<R>
	private isComplete: (event: T) => boolean
	private extractResult: (event: T) => R
	private iterating = false

	constructor(
		isComplete: (event: T) => boolean,
		extractResult: (event: T) => R
	) {
		this.isComplete = isComplete
		this.extractResult = extractResult
		this.resultPromise = new Promise<R>(
			(resolve, reject) => {
				this.resultResolve = resolve
				this.resultReject = reject
			}
		)
	}

	push(event: T): void {
		if (this.done) return

		if (this.isComplete(event)) {
			this.finalResult = this.extractResult(event)
		}

		if (this.resolve) {
			const r = this.resolve
			this.resolve = null
			r({ value: event, done: false })
		} else {
			this.queue.push(event)
		}
	}

	/**
	 * Signal an error — makes the for-await consumer throw.
	 */
	error(err: Error): void {
		if (this.done) return
		this.done = true
		this.resultReject?.(err)
		this.resultResolve = null
		this.resultReject = null

		if (this.resolve) {
			// Reject via a special sentinel so the async iterator throws
			const r = this.resolve
			this.resolve = null
			// Store error for the iterator to throw
			this._error = err
			r({
				done: true,
				value: undefined
			} as IteratorResult<T>)
		} else {
			this._error = err
		}
	}

	private _error: Error | undefined

	end(result?: R): void {
		if (this.done) return
		this.done = true

		if (result !== undefined) {
			this.finalResult = result
		}

		if (this.finalResult !== undefined) {
			this.resultResolve?.(this.finalResult)
		} else {
			this.resultReject?.(
				new Error('EventStream ended without a result')
			)
		}
		this.resultResolve = null
		this.resultReject = null

		if (this.resolve) {
			const r = this.resolve
			this.resolve = null
			r({
				done: true,
				value: undefined
			} as IteratorResult<T>)
		}
	}

	result(): Promise<R> {
		return this.resultPromise
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		if (this.iterating) {
			throw new Error(
				'EventStream does not support concurrent consumers'
			)
		}
		this.iterating = true
		try {
			while (true) {
				const next = this.dequeueOrWait()
				if (next !== undefined) {
					yield next
					continue
				}
				if (this.done) {
					if (this._error) throw this._error
					return
				}

				const value = await new Promise<IteratorResult<T>>(
					resolve => {
						this.resolve = resolve
					}
				)
				if (value.done) {
					if (this._error) throw this._error
					return
				}
				yield value.value
			}
		} finally {
			this.iterating = false
		}
	}

	/**
	 * Try to read the next event from the queue. Returns the event
	 * if available (compacting the queue when needed), or undefined
	 * if the queue is exhausted.
	 */
	private dequeueOrWait(): T | undefined {
		if (this.readIndex >= this.queue.length)
			return undefined

		const event = this.queue[this.readIndex++]
		// Compact when >50% consumed and enough items read
		if (
			this.readIndex > 64 &&
			this.readIndex > this.queue.length / 2
		) {
			this.queue = this.queue.slice(this.readIndex)
			this.readIndex = 0
		}
		return event
	}
}
