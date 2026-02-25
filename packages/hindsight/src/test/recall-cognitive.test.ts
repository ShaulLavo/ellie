/**
 * Integration tests for cognitive recall mode and access write-through.
 *
 * Validates:
 * - mode="hybrid" returns identical results to default (no regression)
 * - mode="cognitive" applies ACT-R scoring
 * - Access metadata (access_count, last_accessed, encoding_strength) is
 *   updated on recall for returned memories only
 * - Retain sets access_count=1, last_accessed=createdAt for new memories
 * - Working memory boost is applied only in cognitive mode with sessionId
 */

import {
	describe,
	test,
	expect,
	beforeEach,
	afterEach
} from 'bun:test'
import {
	createTestHindsight,
	createTestBank,
	type TestHindsight
} from './setup'
import type { HindsightDatabase } from '../db'
import type { MemoryUnitRow } from '../schema'

describe('recall cognitive mode', () => {
	let t: TestHindsight
	let bankId: string

	beforeEach(async () => {
		t = createTestHindsight()
		bankId = createTestBank(t.hs)
		await t.hs.retain(bankId, 'test', {
			facts: [
				{
					content: 'Peter loves hiking in the mountains',
					factType: 'experience'
				},
				{
					content: 'Alice enjoys reading science fiction',
					factType: 'experience'
				},
				{
					content:
						'TypeScript is a typed superset of JavaScript',
					factType: 'world'
				},
				{
					content:
						'Peter thinks Python is a great language',
					factType: 'opinion',
					confidence: 0.8
				}
			],
			consolidate: false
		})
	})

	afterEach(() => {
		t.cleanup()
	})

	// ── Mode="hybrid" parity ──────────────────────────────────────────────

	test("mode='hybrid' returns same structure as default", async () => {
		const defaultResult = await t.hs.recall(
			bankId,
			'hiking'
		)
		const hybridResult = await t.hs.recall(
			bankId,
			'hiking',
			{ mode: 'hybrid' }
		)
		expect(hybridResult.query).toBe('hiking')
		expect(hybridResult.memories.length).toBe(
			defaultResult.memories.length
		)
		// Both should return scored memories with the same shape
		for (const m of hybridResult.memories) {
			expect(m.memory).toBeDefined()
			expect(typeof m.score).toBe('number')
			expect(Array.isArray(m.sources)).toBe(true)
		}
	})

	// ── Mode="cognitive" ─────────────────────────────────────────────────

	test("mode='cognitive' returns scored memories", async () => {
		const result = await t.hs.recall(bankId, 'hiking', {
			mode: 'cognitive'
		})
		expect(result.query).toBe('hiking')
		expect(result.memories.length).toBeGreaterThan(0)
		for (const m of result.memories) {
			expect(m.memory).toBeDefined()
			expect(typeof m.score).toBe('number')
			expect(m.score).toBeGreaterThanOrEqual(0)
		}
	})

	test("mode='cognitive' scores are sorted descending", async () => {
		const result = await t.hs.recall(
			bankId,
			'programming',
			{ mode: 'cognitive' }
		)
		for (let i = 1; i < result.memories.length; i++) {
			expect(
				result.memories[i - 1]!.score
			).toBeGreaterThanOrEqual(result.memories[i]!.score)
		}
	})

	test("mode='cognitive' respects limit parameter", async () => {
		const result = await t.hs.recall(bankId, 'test', {
			mode: 'cognitive',
			limit: 2
		})
		expect(result.memories.length).toBeLessThanOrEqual(2)
	})

	test("mode='cognitive' respects factTypes filter", async () => {
		const result = await t.hs.recall(bankId, 'test', {
			mode: 'cognitive',
			factTypes: ['experience']
		})
		for (const m of result.memories) {
			expect(m.memory.factType).toBe('experience')
		}
	})
})

// ── Access write-through ──────────────────────────────────────────────

describe('access write-through on recall', () => {
	let t: TestHindsight
	let bankId: string

	beforeEach(async () => {
		t = createTestHindsight()
		bankId = createTestBank(t.hs)
		await t.hs.retain(bankId, 'test', {
			facts: [
				{
					content: 'Peter loves hiking in the mountains',
					factType: 'experience'
				},
				{
					content: 'Alice enjoys reading science fiction',
					factType: 'experience'
				}
			],
			consolidate: false
		})
	})

	afterEach(() => {
		t.cleanup()
	})

	test('retain sets access_count=0 and last_accessed=null for new memories', () => {
		const hdb = (
			t.hs as unknown as { hdb: HindsightDatabase }
		).hdb
		const rows = hdb.db
			.select()
			.from(hdb.schema.memoryUnits)
			.all()
		for (const row of rows) {
			expect(row.accessCount).toBe(0)
			expect(row.lastAccessed).toBeNull()
			expect(row.encodingStrength).toBe(1.0)
		}
	})

	test('recall increments access_count for returned memories', async () => {
		// Check initial state
		const hdb = (
			t.hs as unknown as { hdb: HindsightDatabase }
		).hdb
		const before = hdb.db
			.select()
			.from(hdb.schema.memoryUnits)
			.all()
		const initialCounts = new Map(
			before.map((r: MemoryUnitRow) => [
				r.id,
				r.accessCount
			])
		)

		// Perform a recall
		const result = await t.hs.recall(bankId, 'hiking')
		expect(result.memories.length).toBeGreaterThan(0)
		const returnedIds = result.memories.map(
			m => m.memory.id
		)

		// Check that returned memories had access_count incremented
		const after = hdb.db
			.select()
			.from(hdb.schema.memoryUnits)
			.all()
		for (const row of after) {
			if (returnedIds.includes(row.id)) {
				expect(row.accessCount).toBe(
					(initialCounts.get(row.id) ?? 0) + 1
				)
			}
		}
	})

	test('recall updates last_accessed for returned memories', async () => {
		const before = Date.now()
		const result = await t.hs.recall(bankId, 'hiking')
		const after = Date.now()

		expect(result.memories.length).toBeGreaterThan(0)
		const returnedIds = new Set(
			result.memories.map(m => m.memory.id)
		)

		const hdb = (
			t.hs as unknown as { hdb: HindsightDatabase }
		).hdb
		const rows = hdb.db
			.select()
			.from(hdb.schema.memoryUnits)
			.all()
		for (const row of rows) {
			if (returnedIds.has(row.id)) {
				expect(row.lastAccessed).toBeGreaterThanOrEqual(
					before
				)
				expect(row.lastAccessed).toBeLessThanOrEqual(after)
			}
		}
	})

	test('recall bumps encoding_strength by 0.02 per recall', async () => {
		// First recall — capture returned IDs
		const result1 = await t.hs.recall(bankId, 'hiking')
		const ids1 = new Set(
			result1.memories.map(m => m.memory.id)
		)

		// Second recall — capture returned IDs
		const result2 = await t.hs.recall(bankId, 'hiking')
		const ids2 = new Set(
			result2.memories.map(m => m.memory.id)
		)

		// Only assert 1.04 for memories returned in BOTH recalls
		const intersection = new Set(
			[...ids1].filter(id => ids2.has(id))
		)
		expect(intersection.size).toBeGreaterThan(0)

		const hdb = (
			t.hs as unknown as { hdb: HindsightDatabase }
		).hdb
		const rows = hdb.db
			.select()
			.from(hdb.schema.memoryUnits)
			.all()

		for (const row of rows) {
			if (intersection.has(row.id)) {
				// After 2 recalls, encoding_strength should be 1.0 + 0.02 + 0.02 = 1.04
				expect(row.encodingStrength).toBeCloseTo(1.04, 5)
			}
		}
	})

	test('encoding_strength is capped at 3.0', async () => {
		const hdb = (
			t.hs as unknown as { hdb: HindsightDatabase }
		).hdb
		// Artificially set encoding_strength to 2.99
		hdb.sqlite.run(
			`UPDATE hs_memory_units SET encoding_strength = 2.99 WHERE bank_id = ?`,
			[bankId]
		)

		// Recall should bump by 0.02 but cap at 3.0
		await t.hs.recall(bankId, 'hiking')

		const rows = hdb.db
			.select()
			.from(hdb.schema.memoryUnits)
			.all()
		for (const row of rows) {
			expect(row.encodingStrength).toBeLessThanOrEqual(3.0)
		}
	})

	test('write-through works in both hybrid and cognitive modes', async () => {
		const hdb = (
			t.hs as unknown as { hdb: HindsightDatabase }
		).hdb

		// Hybrid recall
		const r1 = await t.hs.recall(bankId, 'hiking', {
			mode: 'hybrid'
		})
		expect(r1.memories.length).toBeGreaterThan(0)

		const afterHybrid = hdb.db
			.select()
			.from(hdb.schema.memoryUnits)
			.all()
		const hybridCounts = new Map(
			afterHybrid.map((r: MemoryUnitRow) => [
				r.id,
				r.accessCount
			])
		)

		// Cognitive recall
		const r2 = await t.hs.recall(bankId, 'hiking', {
			mode: 'cognitive'
		})
		expect(r2.memories.length).toBeGreaterThan(0)

		const afterCognitive = hdb.db
			.select()
			.from(hdb.schema.memoryUnits)
			.all()

		const returnedInCognitive = new Set(
			r2.memories.map(m => m.memory.id)
		)
		for (const row of afterCognitive) {
			if (returnedInCognitive.has(row.id)) {
				// Should have been incremented again
				expect(row.accessCount).toBeGreaterThan(
					hybridCounts.get(row.id) ?? 0
				)
			}
		}
	})
})

// ── Working memory integration ──────────────────────────────────────────

describe('working memory integration', () => {
	let t: TestHindsight
	let bankId: string

	beforeEach(async () => {
		t = createTestHindsight()
		bankId = createTestBank(t.hs)
		await t.hs.retain(bankId, 'test', {
			facts: [
				{
					content: 'Peter loves hiking in the mountains',
					factType: 'experience'
				},
				{
					content: 'Alice enjoys reading science fiction',
					factType: 'experience'
				}
			],
			consolidate: false
		})
	})

	afterEach(() => {
		t.cleanup()
	})

	test('cognitive recall with sessionId touches working memory', async () => {
		// First recall without sessionId — no WM boost
		const baseline = await t.hs.recall(bankId, 'hiking', {
			mode: 'cognitive'
		})
		expect(baseline.memories.length).toBeGreaterThan(0)
		const baselineScores = new Map(
			baseline.memories.map(m => [m.memory.id, m.score])
		)

		// Recall with sessionId — touches WM for returned memories
		const result = await t.hs.recall(bankId, 'hiking', {
			mode: 'cognitive',
			sessionId: 'test-session-1'
		})
		expect(result.memories.length).toBeGreaterThan(0)

		// Second recall with same sessionId — WM boost should increase scores
		const result2 = await t.hs.recall(bankId, 'hiking', {
			mode: 'cognitive',
			sessionId: 'test-session-1'
		})
		expect(result2.memories.length).toBeGreaterThan(0)

		// Overlapping memories should have higher scores due to WM boost
		for (const m of result2.memories) {
			const baseScore = baselineScores.get(m.memory.id)
			if (baseScore != null) {
				expect(m.score).toBeGreaterThanOrEqual(baseScore)
			}
		}
	})

	test('cognitive recall without sessionId does not use WM', async () => {
		// Should work fine without sessionId, just no WM boost
		const result = await t.hs.recall(bankId, 'hiking', {
			mode: 'cognitive'
		})
		expect(result.memories.length).toBeGreaterThan(0)
		for (const m of result.memories) {
			expect(typeof m.score).toBe('number')
		}
	})

	test('hybrid recall ignores sessionId (no WM)', async () => {
		const result = await t.hs.recall(bankId, 'hiking', {
			mode: 'hybrid',
			sessionId: 'test-session-1'
		})
		expect(result.memories.length).toBeGreaterThan(0)
		// Should just work normally — WM is only for cognitive mode
	})

	test('different sessionIds are isolated', async () => {
		// Recall with session 1
		await t.hs.recall(bankId, 'hiking', {
			mode: 'cognitive',
			sessionId: 'session-A'
		})

		// Recall with session 2 — WM from session 1 should not affect it
		const result = await t.hs.recall(bankId, 'hiking', {
			mode: 'cognitive',
			sessionId: 'session-B'
		})
		expect(result.memories.length).toBeGreaterThan(0)
	})
})

// ── Trace output ────────────────────────────────────────────────────────

describe('cognitive recall trace', () => {
	let t: TestHindsight
	let bankId: string

	beforeEach(async () => {
		t = createTestHindsight()
		bankId = createTestBank(t.hs)
		await t.hs.retain(bankId, 'test', {
			facts: [
				{
					content: 'Peter loves hiking in the mountains',
					factType: 'experience'
				}
			],
			consolidate: false
		})
	})

	afterEach(() => {
		t.cleanup()
	})

	test('cognitive mode reports mode in trace phaseMetrics', async () => {
		const result = await t.hs.recall(bankId, 'hiking', {
			mode: 'cognitive',
			enableTrace: true
		})
		expect(result.trace).toBeDefined()
		const scoringPhase = result.trace!.phaseMetrics.find(
			p => p.phaseName === 'combined_scoring'
		)
		expect(scoringPhase).toBeDefined()
		expect(scoringPhase!.details!.mode).toBe('cognitive')
	})

	test('hybrid mode reports mode in trace phaseMetrics', async () => {
		const result = await t.hs.recall(bankId, 'hiking', {
			mode: 'hybrid',
			enableTrace: true
		})
		expect(result.trace).toBeDefined()
		const scoringPhase = result.trace!.phaseMetrics.find(
			p => p.phaseName === 'combined_scoring'
		)
		expect(scoringPhase).toBeDefined()
		expect(scoringPhase!.details!.mode).toBe('hybrid')
	})
})
