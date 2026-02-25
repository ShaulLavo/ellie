/**
 * Phase 3 Verification — Gate 5: Determinism / Reproducibility
 *
 * Runs full Phase 3 eval twice on same commit/config.
 * Pass condition: non-timing metrics are identical across runs.
 *
 * Validates:
 * - packContext produces identical results for same input
 * - scopeMatches produces identical results for same input
 * - normalizePath is deterministic
 * - detectLocationSignals is deterministic
 * - computeLocationBoost is deterministic (given same DB state)
 * - locationFind ordering is deterministic
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ulid } from '@ellie/utils'
import { createTestHindsight, createTestBank, getHdb, type TestHindsight } from './setup'
import type { HindsightDatabase } from '../db'
import {
	normalizePath,
	detectLocationSignals,
	locationRecord,
	locationFind,
	locationStats,
	resolveSignalsToPaths,
	computeLocationBoost,
	getMaxStrengthForPaths
} from '../location'
import { packContext, estimateTokens, type PackCandidate } from '../context-pack'
import { scopeMatches, resolveScope, deriveScopeTagsFromContext } from '../scope'

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

describe('Gate 5: Determinism / Reproducibility', () => {
	// ── Pure function determinism ──────────────────────────────────────────────

	describe('pure function determinism', () => {
		it('normalizePath is deterministic across 100 runs', () => {
			const inputs = [
				'src/lib/Foo.TS',
				'C:\\Users\\dev\\project\\main.ts',
				'  ./relative/path/  ',
				'src//double//slash.ts',
				'/'
			]

			for (const input of inputs) {
				const results = Array.from({ length: 100 }, () => normalizePath(input))
				const first = results[0]
				expect(results.every((r) => r === first)).toBe(true)
			}
		})

		it('detectLocationSignals is deterministic across 50 runs', () => {
			const queries = [
				'What does /src/lib/utils.ts do?',
				'Check src/components/Button.tsx for bugs',
				'The utils.logger module is broken',
				"What is Peter's favorite color?",
				'Look at ./lib/config.ts'
			]

			for (const query of queries) {
				const results = Array.from({ length: 50 }, () => detectLocationSignals(query))
				const first = JSON.stringify(results[0])
				expect(results.every((r) => JSON.stringify(r) === first)).toBe(true)
			}
		})

		it('estimateTokens is deterministic', () => {
			const texts = ['hello', 'x'.repeat(1000), '', 'abcd', 'test string with spaces']
			for (const text of texts) {
				const results = Array.from({ length: 50 }, () => estimateTokens(text))
				expect(new Set(results).size).toBe(1)
			}
		})

		it('scopeMatches is deterministic across all mode combinations', () => {
			const cases = [
				{ mem: { profile: 'a', project: 'p1' }, filter: { profile: 'a', project: 'p1' } },
				{
					mem: { profile: 'a', project: 'p1' },
					filter: { profile: 'b', project: 'p1' }
				},
				{
					mem: { profile: null as string | null, project: null as string | null },
					filter: { profile: 'a', project: 'p1' }
				}
			]

			for (const { mem, filter } of cases) {
				for (const mode of ['strict', 'broad'] as const) {
					const results = Array.from({ length: 50 }, () => scopeMatches(mem, filter, mode))
					expect(new Set(results).size).toBe(1)
				}
			}
		})

		it('resolveScope is deterministic', () => {
			const cases = [
				{ explicit: { profile: 'a', project: 'p1' }, ctx: { profile: 'b', project: 'p2' } },
				{ explicit: undefined, ctx: { profile: 'b', project: 'p2' } },
				{ explicit: { profile: 'a' }, ctx: { project: 'p2' } }
			]

			for (const { explicit, ctx } of cases) {
				const results = Array.from({ length: 50 }, () => resolveScope(explicit, ctx))
				const first = JSON.stringify(results[0])
				expect(results.every((r) => JSON.stringify(r) === first)).toBe(true)
			}
		})

		it('deriveScopeTagsFromContext is deterministic', () => {
			const ctxs = [
				undefined,
				{ profile: 'alice', project: 'proj-a' },
				{ profile: '', project: '' },
				{ profile: 'bob' }
			]

			for (const ctx of ctxs) {
				const results = Array.from({ length: 50 }, () => deriveScopeTagsFromContext(ctx))
				const first = JSON.stringify(results[0])
				expect(results.every((r) => JSON.stringify(r) === first)).toBe(true)
			}
		})
	})

	// ── packContext determinism ────────────────────────────────────────────────

	describe('packContext determinism', () => {
		function makeDataset(): PackCandidate[] {
			return Array.from({ length: 20 }, (_, i) => ({
				id: `mem-${i}`,
				content: `Content for memory ${i}: ${'x'.repeat(200 + ((i * 37) % 400))}`,
				gist: `Gist ${i}: summary info.`,
				score: 1.0 - i * 0.01
			}))
		}

		it('produces identical packed IDs across 10 runs', () => {
			const candidates = makeDataset()
			const budget = 2000

			const runs = Array.from({ length: 10 }, () => packContext(candidates, budget))

			const firstIds = runs[0]!.packed.map((p) => p.id)
			for (let i = 1; i < runs.length; i++) {
				expect(runs[i]!.packed.map((p) => p.id)).toEqual(firstIds)
			}
		})

		it('produces identical totalTokensUsed across 10 runs', () => {
			const candidates = makeDataset()
			const budget = 2000

			const runs = Array.from({ length: 10 }, () => packContext(candidates, budget))

			const firstTokens = runs[0]!.totalTokensUsed
			for (let i = 1; i < runs.length; i++) {
				expect(runs[i]!.totalTokensUsed).toBe(firstTokens)
			}
		})

		it('produces identical mode assignments across 10 runs', () => {
			const candidates = makeDataset()
			const budget = 2000

			const runs = Array.from({ length: 10 }, () => packContext(candidates, budget))

			const firstModes = runs[0]!.packed.map((p) => p.mode)
			for (let i = 1; i < runs.length; i++) {
				expect(runs[i]!.packed.map((p) => p.mode)).toEqual(firstModes)
			}
		})

		it('overflow flag is identical across runs', () => {
			const candidates = makeDataset()

			for (const budget of [100, 500, 2000, 10000]) {
				const runs = Array.from({ length: 10 }, () => packContext(candidates, budget))
				const firstOverflow = runs[0]!.overflow
				for (let i = 1; i < runs.length; i++) {
					expect(runs[i]!.overflow).toBe(firstOverflow)
				}
			}
		})
	})

	// ── DB-dependent determinism ──────────────────────────────────────────────

	describe('DB-dependent determinism', () => {
		let t: TestHindsight
		let bankId: string

		beforeEach(() => {
			t = createTestHindsight()
			bankId = createTestBank(t.hs, 'gate5-determinism')
		})

		afterEach(() => {
			t.cleanup()
		})

		it('locationFind ordering is deterministic for same DB state', () => {
			const hdb = getHdb(t.hs)

			// Seed data
			for (let i = 0; i < 10; i++) {
				const memId = insertTestMemory(hdb, bankId, `Memory ${i}`)
				locationRecord(hdb, bankId, `src/file-${i}.ts`, { memoryId: memId })
			}

			// Run locationFind 10 times
			const runs = Array.from({ length: 10 }, () =>
				locationFind(hdb, bankId, {}).map((h) => h.pathId)
			)

			const first = runs[0]
			for (let i = 1; i < runs.length; i++) {
				expect(runs[i]).toEqual(first)
			}
		})

		it('resolveSignalsToPaths is deterministic for same DB state', () => {
			const hdb = getHdb(t.hs)

			for (let i = 0; i < 5; i++) {
				const memId = insertTestMemory(hdb, bankId, `Memory ${i}`)
				locationRecord(hdb, bankId, `src/module-${i}/index.ts`, { memoryId: memId })
			}

			const signals = ['src/module-0/index.ts', 'src/module-2/index.ts']
			const runs = Array.from({ length: 10 }, () => {
				const map = resolveSignalsToPaths(hdb, bankId, signals)
				return JSON.stringify([...map.entries()].sort())
			})

			const first = runs[0]
			for (let i = 1; i < runs.length; i++) {
				expect(runs[i]).toBe(first)
			}
		})

		it('computeLocationBoost is deterministic for same DB state and timestamp', () => {
			const hdb = getHdb(t.hs)
			const fixedNow = 1700000000000

			const memId = insertTestMemory(hdb, bankId, 'Boost test memory')
			locationRecord(hdb, bankId, 'src/target.ts', { memoryId: memId, session: 'sess-1' })

			const signals = detectLocationSignals('Check src/target.ts')
			const signalMap = resolveSignalsToPaths(hdb, bankId, signals)
			const queryPathIds = new Set<string>()
			for (const ids of signalMap.values()) {
				for (const id of ids) queryPathIds.add(id)
			}
			const maxStrength = getMaxStrengthForPaths(hdb, bankId, queryPathIds)

			const runs = Array.from({ length: 10 }, () =>
				computeLocationBoost(hdb, bankId, memId, queryPathIds, maxStrength, fixedNow)
			)

			const first = runs[0]
			for (let i = 1; i < runs.length; i++) {
				expect(runs[i]).toBe(first)
			}
		})

		it('locationStats is deterministic for same DB state', () => {
			const hdb = getHdb(t.hs)
			const memId = insertTestMemory(hdb, bankId, 'Stats test memory')
			locationRecord(hdb, bankId, 'src/stats-target.ts', { memoryId: memId })

			const runs = Array.from({ length: 10 }, () =>
				JSON.stringify(locationStats(hdb, bankId, 'src/stats-target.ts'))
			)

			const first = runs[0]
			for (let i = 1; i < runs.length; i++) {
				expect(runs[i]).toBe(first)
			}
		})
	})
})
