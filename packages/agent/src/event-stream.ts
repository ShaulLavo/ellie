/**
 * Push-based async iterable for streaming events.
 *
 * Producers push events via `push()` and signal completion via `end()`.
 * Consumers iterate with `for await...of` and can await the final result via `result()`.
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private resolve: ((value: IteratorResult<T>) => void) | null = null;
	private done = false;
	private finalResult: R | undefined;
	private resultResolve: ((result: R) => void) | null = null;
	private resultReject: ((reason: Error) => void) | null = null;
	private resultPromise: Promise<R>;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(
		isComplete: (event: T) => boolean,
		extractResult: (event: T) => R,
	) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.resultPromise = new Promise<R>((resolve, reject) => {
			this.resultResolve = resolve;
			this.resultReject = reject;
		});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.finalResult = this.extractResult(event);
		}

		if (this.resolve) {
			const r = this.resolve;
			this.resolve = null;
			r({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	end(result?: R): void {
		if (this.done) return;
		this.done = true;

		if (result !== undefined) {
			this.finalResult = result;
		}

		if (this.finalResult !== undefined) {
			this.resultResolve?.(this.finalResult);
		} else {
			this.resultReject?.(
				new Error("EventStream ended without a result"),
			);
		}
		this.resultResolve = null;
		this.resultReject = null;

		if (this.resolve) {
			const r = this.resolve;
			this.resolve = null;
			r({ value: undefined as any, done: true });
		}
	}

	result(): Promise<R> {
		return this.resultPromise;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				const value = await new Promise<IteratorResult<T>>((resolve) => {
					this.resolve = resolve;
				});
				if (value.done) return;
				yield value.value;
			}
		}
	}
}
