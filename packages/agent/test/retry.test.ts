import { describe, expect, test, jest } from 'bun:test'
import {
	withRetry,
	calculateDelay,
	abortableSleep
} from '../src/retry'
import type { RetryOptions } from '../src/retry'

// ============================================================================
// calculateDelay
// ============================================================================

describe('calculateDelay', () => {
	const baseOpts: RetryOptions = {
		maxAttempts: 3,
		baseDelayMs: 1000,
		maxDelayMs: 30000,
		backoffMultiplier: 2
	}

	test('first retry uses base delay (±jitter)', () => {
		const delays = Array.from({ length: 100 }, () =>
			calculateDelay(1, baseOpts)
		)
		// Base delay is 1000, jitter ±20% → range [800, 1200]
		for (const d of delays) {
			expect(d).toBeGreaterThanOrEqual(800)
			expect(d).toBeLessThanOrEqual(1200)
		}
	})

	test('second retry doubles the delay (±jitter)', () => {
		const delays = Array.from({ length: 100 }, () =>
			calculateDelay(2, baseOpts)
		)
		// 1000 * 2^1 = 2000, jitter ±20% → range [1600, 2400]
		for (const d of delays) {
			expect(d).toBeGreaterThanOrEqual(1600)
			expect(d).toBeLessThanOrEqual(2400)
		}
	})

	test('delay is capped at maxDelayMs', () => {
		const opts = { ...baseOpts, maxDelayMs: 5000 }
		// attempt 10 → 1000 * 2^9 = 512000, but capped at 5000
		const delays = Array.from({ length: 100 }, () =>
			calculateDelay(10, opts)
		)
		for (const d of delays) {
			// 5000 ± 20% → [4000, 6000] but capped at 5000 before jitter
			expect(d).toBeLessThanOrEqual(6000)
			expect(d).toBeGreaterThanOrEqual(4000)
		}
	})

	test('respects retryAfterMs when larger than calculated', () => {
		const delays = Array.from({ length: 100 }, () =>
			calculateDelay(1, baseOpts, 5000)
		)
		// retryAfterMs=5000 > base=1000, so delay ≈ 5000 ± 20%
		for (const d of delays) {
			expect(d).toBeGreaterThanOrEqual(4000)
			expect(d).toBeLessThanOrEqual(6000)
		}
	})

	test('ignores retryAfterMs when smaller than calculated', () => {
		const delays = Array.from({ length: 100 }, () =>
			calculateDelay(2, baseOpts, 500)
		)
		// retryAfterMs=500 < calculated=2000, so delay ≈ 2000 ± 20%
		for (const d of delays) {
			expect(d).toBeGreaterThanOrEqual(1600)
			expect(d).toBeLessThanOrEqual(2400)
		}
	})

	test('retryAfterMs is still capped at maxDelayMs', () => {
		const opts = { ...baseOpts, maxDelayMs: 3000 }
		const delays = Array.from({ length: 100 }, () =>
			calculateDelay(1, opts, 50000)
		)
		// retryAfterMs=50000, but capped at maxDelayMs=3000 ± 20%
		for (const d of delays) {
			expect(d).toBeLessThanOrEqual(3600)
			expect(d).toBeGreaterThanOrEqual(2400)
		}
	})

	test('returns integer values', () => {
		for (let i = 0; i < 50; i++) {
			const d = calculateDelay(1, baseOpts)
			expect(d).toBe(Math.round(d))
		}
	})
})

// ============================================================================
// abortableSleep
// ============================================================================

describe('abortableSleep', () => {
	test('resolves to true after duration', async () => {
		const result = await abortableSleep(10)
		expect(result).toBe(true)
	})

	test('resolves to false if already aborted', async () => {
		const ac = new AbortController()
		ac.abort()
		const result = await abortableSleep(1000, ac.signal)
		expect(result).toBe(false)
	})

	test('resolves to false when aborted during sleep', async () => {
		const ac = new AbortController()
		const p = abortableSleep(5000, ac.signal)
		setTimeout(() => ac.abort(), 10)
		const result = await p
		expect(result).toBe(false)
	})

	test('resolves immediately for zero or negative ms', async () => {
		expect(await abortableSleep(0)).toBe(true)
		expect(await abortableSleep(-100)).toBe(true)
	})
})

// ============================================================================
// withRetry
// ============================================================================

describe('withRetry', () => {
	test('returns result on first success', async () => {
		const fn = jest.fn(async () => 42)
		const result = await withRetry(fn)
		expect(result).toBe(42)
		expect(fn).toHaveBeenCalledTimes(1)
	})

	test('retries on failure and succeeds', async () => {
		let callCount = 0
		const fn = async () => {
			callCount++
			if (callCount < 3) throw new Error('transient')
			return 'ok'
		}
		const result = await withRetry(fn, {
			maxAttempts: 3,
			baseDelayMs: 10,
			maxDelayMs: 50
		})
		expect(result).toBe('ok')
		expect(callCount).toBe(3)
	})

	test('throws last error after maxAttempts', async () => {
		let callCount = 0
		const fn = async () => {
			callCount++
			throw new Error(`fail ${callCount}`)
		}
		await expect(
			withRetry(fn, {
				maxAttempts: 3,
				baseDelayMs: 10,
				maxDelayMs: 50
			})
		).rejects.toThrow('fail 3')
		expect(callCount).toBe(3)
	})

	test('stops retrying when shouldRetry returns false', async () => {
		let callCount = 0
		const fn = async () => {
			callCount++
			throw new Error('auth error')
		}
		await expect(
			withRetry(fn, {
				maxAttempts: 5,
				baseDelayMs: 10,
				shouldRetry: () => false
			})
		).rejects.toThrow('auth error')
		// Called once, shouldRetry returned false, no more attempts
		expect(callCount).toBe(1)
	})

	test('calls onRetry with error, attempt, and delay', async () => {
		let callCount = 0
		const onRetryCalls: Array<{
			attempt: number
			delayMs: number
		}> = []
		const fn = async () => {
			callCount++
			if (callCount < 3) throw new Error('oops')
			return 'done'
		}
		await withRetry(fn, {
			maxAttempts: 3,
			baseDelayMs: 10,
			maxDelayMs: 100,
			onRetry: (_err, attempt, delayMs) => {
				onRetryCalls.push({ attempt, delayMs })
			}
		})
		expect(onRetryCalls.length).toBe(2)
		expect(onRetryCalls[0].attempt).toBe(1)
		expect(onRetryCalls[1].attempt).toBe(2)
		// Delays should be positive numbers
		for (const call of onRetryCalls) {
			expect(call.delayMs).toBeGreaterThan(0)
		}
	})

	test('aborts before first attempt if signal is already aborted', async () => {
		const ac = new AbortController()
		ac.abort()
		const fn = jest.fn(async () => 42)
		await expect(
			withRetry(fn, { signal: ac.signal })
		).rejects.toThrow('Retry aborted')
		expect(fn).not.toHaveBeenCalled()
	})

	test('aborts during backoff sleep', async () => {
		const ac = new AbortController()
		let callCount = 0
		const fn = async () => {
			callCount++
			throw new Error('fail')
		}
		// Abort after a short delay (during the backoff sleep)
		setTimeout(() => ac.abort(), 30)
		await expect(
			withRetry(fn, {
				maxAttempts: 5,
				baseDelayMs: 5000, // Long sleep to ensure abort happens during it
				signal: ac.signal
			})
		).rejects.toThrow('Retry aborted during backoff')
		// Should have called fn once, then tried to sleep and got aborted
		expect(callCount).toBe(1)
	})

	test('throws if maxAttempts < 1', async () => {
		await expect(
			withRetry(async () => 42, { maxAttempts: 0 })
		).rejects.toThrow('maxAttempts must be >= 1')
	})

	test('maxAttempts: 1 means no retries', async () => {
		let callCount = 0
		const fn = async () => {
			callCount++
			throw new Error('fail')
		}
		await expect(
			withRetry(fn, { maxAttempts: 1 })
		).rejects.toThrow('fail')
		expect(callCount).toBe(1)
	})

	test('extracts retryAfterMs from error object', async () => {
		let callCount = 0
		const delays: number[] = []
		const fn = async () => {
			callCount++
			if (callCount < 2) {
				const err = new Error('rate limited') as Error & {
					retryAfterMs: number
				}
				err.retryAfterMs = 200
				throw err
			}
			return 'ok'
		}
		await withRetry(fn, {
			maxAttempts: 3,
			baseDelayMs: 10,
			maxDelayMs: 500,
			onRetry: (_err, _attempt, delayMs) => {
				delays.push(delayMs)
			}
		})
		// The delay should respect retryAfterMs=200 (much larger than baseDelayMs=10)
		// 200 ± 20% jitter → [160, 240]
		expect(delays[0]).toBeGreaterThanOrEqual(150)
		expect(delays[0]).toBeLessThanOrEqual(250)
	})

	test('succeeds immediately without delay on first try', async () => {
		const start = Date.now()
		await withRetry(async () => 'fast', {
			baseDelayMs: 5000
		})
		const elapsed = Date.now() - start
		expect(elapsed).toBeLessThan(100) // No backoff delay
	})

	test('backoff delays increase exponentially', async () => {
		let callCount = 0
		const delays: number[] = []
		const fn = async () => {
			callCount++
			if (callCount <= 3) throw new Error('fail')
			return 'ok'
		}
		await withRetry(fn, {
			maxAttempts: 4,
			baseDelayMs: 100,
			maxDelayMs: 10000,
			backoffMultiplier: 2,
			onRetry: (_err, _attempt, delayMs) => {
				delays.push(delayMs)
			}
		})
		// delays should roughly be: ~100, ~200, ~400
		expect(delays.length).toBe(3)
		// Each should be roughly double the previous (within jitter tolerance)
		// delay[1] / delay[0] should be approximately 2
		const ratio = delays[1] / delays[0]
		expect(ratio).toBeGreaterThan(1.2)
		expect(ratio).toBeLessThan(3.5)
	})
})
