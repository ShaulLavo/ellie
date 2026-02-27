/**
 * Locker interfaces and MemoryLocker implementation.
 * Adapted from tus-node-server (MIT) — see ATTRIBUTION.md
 */

import { ERRORS } from './constants'

export type RequestRelease = () => Promise<void> | void

export interface Locker {
	newLock(id: string): Lock
}

export interface Lock {
	lock(
		signal: AbortSignal,
		cancelReq: RequestRelease
	): Promise<void>
	unlock(): Promise<void>
}

export interface CancellationContext {
	signal: AbortSignal
	abort: () => void
	cancel: () => void
}

interface LockEntry {
	requestRelease: RequestRelease
}

export class MemoryLocker implements Locker {
	timeout: number
	locks = new Map<string, LockEntry>()

	constructor(options?: { acquireLockTimeout?: number }) {
		this.timeout = options?.acquireLockTimeout ?? 1000 * 30
	}

	newLock(id: string): Lock {
		return new MemoryLock(id, this, this.timeout)
	}
}

class MemoryLock implements Lock {
	constructor(
		private id: string,
		private locker: MemoryLocker,
		private timeout: number = 1000 * 30
	) {}

	async lock(
		stopSignal: AbortSignal,
		requestRelease: RequestRelease
	): Promise<void> {
		const abortController = new AbortController()
		const onAbort = () => {
			abortController.abort()
		}
		stopSignal.addEventListener('abort', onAbort)

		try {
			const lock = await Promise.race([
				this.waitTimeout(abortController.signal),
				this.acquireLock(
					this.id,
					requestRelease,
					abortController.signal
				)
			])

			if (!lock) {
				throw ERRORS.ERR_LOCK_TIMEOUT
			}
		} finally {
			stopSignal.removeEventListener('abort', onAbort)
			abortController.abort()
		}
	}

	private async acquireLock(
		id: string,
		requestRelease: RequestRelease,
		signal: AbortSignal
	): Promise<boolean> {
		const lock = this.locker.locks.get(id)

		if (signal.aborted) {
			return typeof lock !== 'undefined'
		}

		if (!lock) {
			this.locker.locks.set(id, { requestRelease })
			return true
		}

		await lock.requestRelease?.()

		return await new Promise((resolve, reject) => {
			setImmediate(() => {
				this.acquireLock(id, requestRelease, signal)
					.then(resolve)
					.catch(reject)
			})
		})
	}

	async unlock(): Promise<void> {
		const lock = this.locker.locks.get(this.id)
		if (!lock) {
			throw new Error('Releasing an unlocked lock!')
		}
		this.locker.locks.delete(this.id)
	}

	private waitTimeout(
		signal: AbortSignal
	): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			const timeout = setTimeout(() => {
				resolve(false)
			}, this.timeout)

			const abortListener = () => {
				clearTimeout(timeout)
				signal.removeEventListener('abort', abortListener)
				resolve(false)
			}
			signal.addEventListener('abort', abortListener)
		})
	}
}
