/**
 * Tests for the cognitive scoring module (retrieval/cognitive.ts)
 * and the working memory store (working-memory.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestHindsight, createTestBank, type TestHindsight } from './setup'
import type { HindsightDatabase } from '../db'
import {
	computeProbe,
	computeBase,
	computeSpread,
	computeCognitiveScore,
	scoreCognitive,
	type CognitiveCandidate
} from '../retrieval/cognitive'
import { WorkingMemoryStore } from '../working-memory'

// ============================================================================
// Pure function tests (no DB needed)
// ============================================================================

describe('computeProbe', () => {
	test('returns 0 for similarity=0', () => {
		expect(computeProbe(0)).toBe(0)
	})

	test('returns 1 for similarity=1', () => {
		expect(computeProbe(1)).toBe(1)
	})

	test('applies power-law (1.35 exponent)', () => {
		const result = computeProbe(0.5)
		const expected = 0.5 ** 1.35
		expect(result).toBeCloseTo(expected, 10)
	})

	test('clamps negative values to 0', () => {
		expect(computeProbe(-0.5)).toBe(0)
	})

	test('clamps values > 1 to 1', () => {
		expect(computeProbe(1.5)).toBe(1)
	})
})

describe('computeBase', () => {
	test('returns 0 when lastAccessed is null', () => {
		expect(computeBase(5, null, Date.now())).toBe(0)
	})

	test('returns positive value for recently accessed memory', () => {
		const now = Date.now()
		const result = computeBase(3, now - 1000, now) // 1 second ago
		expect(result).toBeGreaterThan(0)
	})

	test('decays with time (tau = 7 days)', () => {
		const now = Date.now()
		const recent = computeBase(3, now - 1000, now) // 1 second ago
		const old = computeBase(3, now - 7 * 24 * 3600 * 1000, now) // 7 days ago
		expect(recent).toBeGreaterThan(old)
	})

	test('increases with access count (logarithmic)', () => {
		const now = Date.now()
		const fewAccesses = computeBase(1, now - 1000, now)
		const manyAccesses = computeBase(100, now - 1000, now)
		expect(manyAccesses).toBeGreaterThan(fewAccesses)
	})

	test('uses ln(1 + accessCount) for frequency', () => {
		const now = Date.now()
		const result = computeBase(10, now, now) // accessed right now
		const expected = Math.log1p(10) * Math.exp(0)
		expect(result).toBeCloseTo(expected, 10)
	})

	test('clamps timeDelta to 0 when now < lastAccessed (clock skew)', () => {
		const now = Date.now()
		const result = computeBase(5, now + 10000, now) // future lastAccessed
		const expected = Math.log1p(5) * Math.exp(0) // timeDelta clamped to 0
		expect(result).toBeCloseTo(expected, 10)
	})

	test('encoding_strength multiplies base activation', () => {
		const now = Date.now()
		const base1 = computeBase(5, now - 1000, now, 1.0)
		const base2 = computeBase(5, now - 1000, now, 2.0)
		expect(base2).toBeCloseTo(base1 * 2, 10)
	})

	test('encoding_strength defaults to 1.0', () => {
		const now = Date.now()
		const withDefault = computeBase(5, now - 1000, now)
		const withExplicit = computeBase(5, now - 1000, now, 1.0)
		expect(withDefault).toBe(withExplicit)
	})
})

describe('computeSpread', () => {
	test('returns 0 when no links exist', () => {
		const activations = new Map([['other', 0.5]])
		expect(computeSpread('target', activations, [])).toBe(0)
	})

	test('returns positive value when neighbors have activation', () => {
		const activations = new Map([['neighbor1', 0.8]])
		const links = [{ sourceId: 'target', targetId: 'neighbor1', weight: 1.0 }]
		const result = computeSpread('target', activations, links)
		expect(result).toBeGreaterThan(0)
		expect(result).toBeLessThan(1) // normalized via 1 - exp(-x)
	})

	test('higher link weight produces higher spread', () => {
		const activations = new Map([['neighbor1', 0.8]])
		const linksLow = [{ sourceId: 'target', targetId: 'neighbor1', weight: 0.2 }]
		const linksHigh = [{ sourceId: 'target', targetId: 'neighbor1', weight: 1.0 }]
		const low = computeSpread('target', activations, linksLow)
		const high = computeSpread('target', activations, linksHigh)
		expect(high).toBeGreaterThan(low)
	})

	test('works when candidate is on either side of the link', () => {
		const activations = new Map([['neighbor1', 0.8]])
		const linksForward = [{ sourceId: 'target', targetId: 'neighbor1', weight: 1.0 }]
		const linksBackward = [{ sourceId: 'neighbor1', targetId: 'target', weight: 1.0 }]
		const forward = computeSpread('target', activations, linksForward)
		const backward = computeSpread('target', activations, linksBackward)
		expect(forward).toBeCloseTo(backward, 10)
	})
})

describe('computeCognitiveScore', () => {
	test('applies correct weights: 0.50*probe + 0.35*base + 0.15*spread', () => {
		const probe = 0.8
		const base = 0.6
		const spread = 0.4
		const expected = 0.5 * probe + 0.35 * base + 0.15 * spread
		expect(computeCognitiveScore(probe, base, spread)).toBeCloseTo(expected, 10)
	})

	test('returns 0 when all inputs are 0', () => {
		expect(computeCognitiveScore(0, 0, 0)).toBe(0)
	})
})

// ============================================================================
// Working Memory Store tests
// ============================================================================

describe('WorkingMemoryStore', () => {
	let wm: WorkingMemoryStore

	beforeEach(() => {
		wm = new WorkingMemoryStore()
	})

	test('returns 0 boost for unknown key', () => {
		expect(wm.getBoost('bank1', 'session1', 'mem1', Date.now())).toBe(0)
	})

	test('returns positive boost after touch', () => {
		const now = Date.now()
		wm.touch('bank1', 'session1', ['mem1'], now)
		const boost = wm.getBoost('bank1', 'session1', 'mem1', now)
		expect(boost).toBeCloseTo(0.2, 2) // 0.20 * exp(0)
	})

	test('boost decays over time', () => {
		const now = Date.now()
		wm.touch('bank1', 'session1', ['mem1'], now)
		const boostNow = wm.getBoost('bank1', 'session1', 'mem1', now)
		const boostLater = wm.getBoost('bank1', 'session1', 'mem1', now + 450_000) // 7.5 min
		expect(boostLater).toBeLessThan(boostNow)
		expect(boostLater).toBeGreaterThan(0)
	})

	test('returns 0 after decay period (15 min)', () => {
		const now = Date.now()
		wm.touch('bank1', 'session1', ['mem1'], now)
		const boost = wm.getBoost('bank1', 'session1', 'mem1', now + 900_001)
		expect(boost).toBe(0)
	})

	test('evicts LRU entries when capacity exceeded (40)', () => {
		const now = Date.now()
		const ids = Array.from({ length: 45 }, (_, i) => `mem${i}`)
		wm.touch('bank1', 'session1', ids, now)
		const entries = wm.getEntries('bank1', 'session1', now)
		expect(entries.length).toBe(40)
		// Oldest 5 (mem0–mem4) should be evicted, mem5–mem44 should remain
		const survivingIds = new Set(entries.map(e => e.memoryId))
		for (let i = 0; i < 5; i++) {
			expect(survivingIds.has(`mem${i}`)).toBe(false)
		}
		for (let i = 5; i < 45; i++) {
			expect(survivingIds.has(`mem${i}`)).toBe(true)
		}
	})

	test('updates touchedAt for existing entries', () => {
		const now = Date.now()
		wm.touch('bank1', 'session1', ['mem1'], now)
		wm.touch('bank1', 'session1', ['mem1'], now + 5000)
		// Boost should be based on the more recent touch
		const boost = wm.getBoost('bank1', 'session1', 'mem1', now + 5000)
		expect(boost).toBeCloseTo(0.2, 2)
	})

	test('isolates different sessions', () => {
		const now = Date.now()
		wm.touch('bank1', 'session1', ['mem1'], now)
		expect(wm.getBoost('bank1', 'session2', 'mem1', now)).toBe(0)
	})

	test('isolates different banks', () => {
		const now = Date.now()
		wm.touch('bank1', 'session1', ['mem1'], now)
		expect(wm.getBoost('bank2', 'session1', 'mem1', now)).toBe(0)
	})

	test('clear removes all entries', () => {
		const now = Date.now()
		wm.touch('bank1', 'session1', ['mem1'], now)
		wm.clear()
		expect(wm.getBoost('bank1', 'session1', 'mem1', now)).toBe(0)
	})

	test('lazy cleanup removes expired entries on read', () => {
		const now = Date.now()
		wm.touch('bank1', 'session1', ['mem1'], now)
		// After expiry, getEntries should return empty
		const entries = wm.getEntries('bank1', 'session1', now + 900_001)
		expect(entries.length).toBe(0)
	})
})

// ============================================================================
// Integrated cognitive scorer tests (with DB)
// ============================================================================

describe('scoreCognitive (with DB)', () => {
	let ctx: TestHindsight
	let _bankId: string

	beforeEach(() => {
		ctx = createTestHindsight()
		_bankId = createTestBank(ctx.hs)
	})

	afterEach(() => {
		ctx.cleanup()
	})

	test('returns empty array for empty candidates', () => {
		const result = scoreCognitive(
			(ctx.hs as unknown as { hdb: HindsightDatabase }).hdb,
			[],
			Date.now()
		)
		expect(result).toEqual([])
	})

	test('ranks by probe when no access history', () => {
		const candidates: CognitiveCandidate[] = [
			{
				id: 'a',
				semanticSimilarity: 0.3,
				accessCount: 0,
				lastAccessed: null,
				encodingStrength: 1.0
			},
			{
				id: 'b',
				semanticSimilarity: 0.9,
				accessCount: 0,
				lastAccessed: null,
				encodingStrength: 1.0
			},
			{
				id: 'c',
				semanticSimilarity: 0.6,
				accessCount: 0,
				lastAccessed: null,
				encodingStrength: 1.0
			}
		]

		const result = scoreCognitive(
			(ctx.hs as unknown as { hdb: HindsightDatabase }).hdb,
			candidates,
			Date.now()
		)
		expect(result.length).toBe(3)
		expect(result[0]!.id).toBe('b') // highest similarity
		expect(result[1]!.id).toBe('c')
		expect(result[2]!.id).toBe('a') // lowest similarity
	})

	test('access history boosts score via base activation', () => {
		const now = Date.now()
		const candidates: CognitiveCandidate[] = [
			{
				id: 'fresh',
				semanticSimilarity: 0.5,
				accessCount: 10,
				lastAccessed: now - 1000,
				encodingStrength: 1.0
			},
			{
				id: 'stale',
				semanticSimilarity: 0.5,
				accessCount: 0,
				lastAccessed: null,
				encodingStrength: 1.0
			}
		]

		const result = scoreCognitive(
			(ctx.hs as unknown as { hdb: HindsightDatabase }).hdb,
			candidates,
			now
		)
		expect(result[0]!.id).toBe('fresh') // boosted by base activation
		expect(result[0]!.cognitiveScore).toBeGreaterThan(result[1]!.cognitiveScore)
	})

	test('deterministic tie-break by id ASC', () => {
		const candidates: CognitiveCandidate[] = [
			{
				id: 'bbb',
				semanticSimilarity: 0.5,
				accessCount: 0,
				lastAccessed: null,
				encodingStrength: 1.0
			},
			{
				id: 'aaa',
				semanticSimilarity: 0.5,
				accessCount: 0,
				lastAccessed: null,
				encodingStrength: 1.0
			}
		]

		const result = scoreCognitive(
			(ctx.hs as unknown as { hdb: HindsightDatabase }).hdb,
			candidates,
			Date.now()
		)
		// Same score → sort by id ASC
		expect(result[0]!.id).toBe('aaa')
		expect(result[1]!.id).toBe('bbb')
	})

	test('all scores are deterministic across runs', () => {
		const now = 1700000000000
		const candidates: CognitiveCandidate[] = [
			{
				id: 'a',
				semanticSimilarity: 0.7,
				accessCount: 5,
				lastAccessed: now - 86400000,
				encodingStrength: 1.0
			},
			{
				id: 'b',
				semanticSimilarity: 0.4,
				accessCount: 2,
				lastAccessed: now - 3600000,
				encodingStrength: 1.0
			}
		]

		const run1 = scoreCognitive(
			(ctx.hs as unknown as { hdb: HindsightDatabase }).hdb,
			candidates,
			now
		)
		const run2 = scoreCognitive(
			(ctx.hs as unknown as { hdb: HindsightDatabase }).hdb,
			candidates,
			now
		)

		expect(run1[0]!.cognitiveScore).toBe(run2[0]!.cognitiveScore)
		expect(run1[1]!.cognitiveScore).toBe(run2[1]!.cognitiveScore)
		expect(run1[0]!.id).toBe(run2[0]!.id)
	})
})
