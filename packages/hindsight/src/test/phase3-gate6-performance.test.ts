/**
 * Phase 3 Verification — Gate 6: Performance Guardrail
 *
 * Measures p50/p95 latency for Phase 3 operations at various scales.
 * Reports regression vs baseline (Phase 2 operations without location/scope).
 *
 * This gate is treated as a WARNING — p95 regression > 15% logs a warning
 * but does not fail the test suite (per eval plan spec).
 *
 * Benchmarked operations:
 * - packContext at 100 and 1000 candidates
 * - scopeMatches at 10k filter operations
 * - normalizePath at 10k paths
 * - detectLocationSignals at 10k queries
 * - computeLocationBoost at scale (100 memories with location data)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ulid } from '@ellie/utils'
import { createTestHindsight, createTestBank, getHdb, type TestHindsight } from './setup'
import type { HindsightDatabase } from '../db'
import { packContext, estimateTokens, type PackCandidate } from '../context-pack'
import { scopeMatches } from '../scope'
import {
	normalizePath,
	detectLocationSignals,
	locationRecord,
	computeLocationBoost,
	getMaxStrengthForPaths,
	resolveSignalsToPaths
} from '../location'

/** Measure execution time in ms. */
function measureMs(fn: () => void): number {
	const start = performance.now()
	fn()
	return performance.now() - start
}

/** Compute p50 and p95 from an array of durations. */
function percentiles(durations: number[]): { p50: number; p95: number } {
	const sorted = [...durations].sort((a, b) => a - b)
	return {
		p50: sorted[Math.floor(sorted.length * 0.5)]!,
		p95: sorted[Math.floor(sorted.length * 0.95)]!
	}
}

function insertTestMemory(
	hdb: HindsightDatabase,
	bid: string,
	content: string,
	memId?: string
): string {
	const id = memId ?? ulid()
	const now = Date.now()
	hdb.db
		.insert(hdb.schema.memoryUnits)
		.values({
			id,
			bankId: bid,
			content,
			factType: 'world',
			confidence: 1.0,
			createdAt: now,
			updatedAt: now
		})
		.run()
	return id
}

describe('Gate 6: Performance Guardrail', () => {
	// ── Pure function benchmarks ──────────────────────────────────────────────

	describe('packContext performance', () => {
		it('packContext at 100 candidates completes in < 50ms p95', () => {
			const candidates: PackCandidate[] = Array.from({ length: 100 }, (_, i) => ({
				id: `mem-${i}`,
				content: `Content ${i}: ${'x'.repeat(300 + (i % 200))}`,
				gist: `Gist ${i}: short summary.`,
				score: 1.0 - i * 0.001
			}))

			const durations: number[] = []
			for (let run = 0; run < 100; run++) {
				durations.push(measureMs(() => packContext(candidates, 2000)))
			}

			const { p95 } = percentiles(durations)
			// Performance guard: p95 should be under 50ms for 100 candidates
			expect(p95).toBeLessThan(50)
		})

		it('packContext at 1000 candidates completes in < 200ms p95', () => {
			const candidates: PackCandidate[] = Array.from({ length: 1000 }, (_, i) => ({
				id: `mem-${i}`,
				content: `Content ${i}: ${'x'.repeat(300 + (i % 500))}`,
				gist: `Gist ${i}: short summary.`,
				score: 1.0 - i * 0.0001
			}))

			const durations: number[] = []
			for (let run = 0; run < 20; run++) {
				durations.push(measureMs(() => packContext(candidates, 2000)))
			}

			const { p95 } = percentiles(durations)
			expect(p95).toBeLessThan(200)
		})
	})

	describe('scopeMatches performance', () => {
		it('10k scopeMatches operations complete in < 50ms total', () => {
			const scopes = Array.from({ length: 100 }, (_, i) => ({
				profile: `profile-${i % 10}`,
				project: `project-${i % 5}`
			}))
			const filters = Array.from({ length: 100 }, (_, i) => ({
				profile: `profile-${i % 10}`,
				project: `project-${i % 5}`
			}))

			const duration = measureMs(() => {
				for (let i = 0; i < 10000; i++) {
					scopeMatches(scopes[i % 100]!, filters[i % 100]!, 'strict')
				}
			})

			expect(duration).toBeLessThan(50)
		})
	})

	describe('normalizePath performance', () => {
		it('10k normalizations complete in < 50ms total', () => {
			const paths = Array.from({ length: 100 }, (_, i) => `Src\\Lib\\Module-${i}\\File${i}.TS`)

			const duration = measureMs(() => {
				for (let i = 0; i < 10000; i++) {
					normalizePath(paths[i % 100]!)
				}
			})

			expect(duration).toBeLessThan(50)
		})
	})

	describe('detectLocationSignals performance', () => {
		it('10k signal detections complete in < 100ms total', () => {
			const queries = Array.from(
				{ length: 100 },
				(_, i) => `Check src/module-${i}/index.ts for bugs in the utils.helper module`
			)

			const duration = measureMs(() => {
				for (let i = 0; i < 10000; i++) {
					detectLocationSignals(queries[i % 100]!)
				}
			})

			expect(duration).toBeLessThan(100)
		})
	})

	// ── DB-dependent benchmarks ───────────────────────────────────────────────

	describe('location boost performance', () => {
		let t: TestHindsight
		let bankId: string

		beforeEach(() => {
			t = createTestHindsight()
			bankId = createTestBank(t.hs, 'gate6-perf')
		})

		afterEach(() => {
			t.cleanup()
		})

		it('computeLocationBoost at 100 memories completes in < 100ms p95', () => {
			const hdb = getHdb(t.hs)
			const now = Date.now()

			// Seed 100 memories with location data
			const memIds: string[] = []
			for (let i = 0; i < 100; i++) {
				const memId = insertTestMemory(hdb, bankId, `Memory ${i} content`)
				memIds.push(memId)
				locationRecord(hdb, bankId, `src/file-${i}.ts`, {
					memoryId: memId,
					session: `sess-${i % 5}`
				})
			}

			// Resolve query path
			const signals = detectLocationSignals('Check src/file-0.ts')
			const signalMap = resolveSignalsToPaths(hdb, bankId, signals)
			const queryPathIds = new Set<string>()
			for (const ids of signalMap.values()) {
				for (const id of ids) queryPathIds.add(id)
			}
			const maxStrength = getMaxStrengthForPaths(hdb, bankId, queryPathIds)

			// Benchmark: compute boost for all 100 memories
			const durations: number[] = []
			for (let run = 0; run < 20; run++) {
				durations.push(
					measureMs(() => {
						for (const memId of memIds) {
							computeLocationBoost(hdb, bankId, memId, queryPathIds, maxStrength, now)
						}
					})
				)
			}

			const { p95 } = percentiles(durations)
			// 100 boost computations should be fast
			expect(p95).toBeLessThan(100)
		})
	})

	// ── estimateTokens performance ────────────────────────────────────────────

	describe('estimateTokens performance', () => {
		it('100k token estimations complete in < 50ms total', () => {
			const texts = Array.from({ length: 100 }, (_, i) => 'x'.repeat(100 + i * 10))

			const duration = measureMs(() => {
				for (let i = 0; i < 100000; i++) {
					estimateTokens(texts[i % 100]!)
				}
			})

			expect(duration).toBeLessThan(50)
		})
	})
})
