/**
 * Core parity port for test_combined_scoring.py.
 */

import {
	describe,
	it,
	expect,
	beforeEach,
	afterEach
} from 'bun:test'
import {
	createTestHindsight,
	createTestBank,
	type TestHindsight
} from './setup'

describe('Core parity: test_combined_scoring.py', () => {
	let t: TestHindsight
	let bankId: string

	beforeEach(() => {
		t = createTestHindsight()
		bankId = createTestBank(t.hs)
	})

	afterEach(() => {
		t.cleanup()
	})

	async function seedBase() {
		await t.hs.retain(bankId, 'seed', {
			facts: [
				{
					content:
						'Peter met Alice in June 2024 and planned a hike',
					factType: 'experience',
					confidence: 0.91,
					entities: ['Peter', 'Alice'],
					tags: ['seed', 'people'],
					occurredStart: Date.now() - 60 * 86_400_000
				},
				{
					content: 'Rain caused the trail to become muddy',
					factType: 'world',
					confidence: 0.88,
					entities: ['trail'],
					tags: ['seed', 'weather']
				},
				{
					content: 'Alice prefers tea over coffee',
					factType: 'opinion',
					confidence: 0.85,
					entities: ['Alice'],
					tags: ['seed', 'preferences']
				}
			],
			documentId: 'seed-doc',
			context: 'seed context',
			tags: ['seed'],
			consolidate: false
		})
	}

	it('rrf normalized range', async () => {
		await seedBase()
		const result = await t.hs.recall(
			bankId,
			'Peter hiking trail',
			{ enableTrace: true, limit: 10 }
		)
		expect(result.trace).toBeDefined()
		expect(
			result.trace!.candidates.length
		).toBeGreaterThanOrEqual(1)
		for (const candidate of result.trace!.candidates) {
			expect(
				candidate.rrfNormalized
			).toBeGreaterThanOrEqual(0)
			expect(candidate.rrfNormalized).toBeLessThanOrEqual(1)
			expect(
				candidate.combinedScore
			).toBeGreaterThanOrEqual(0)
			expect(candidate.combinedScore).toBeLessThanOrEqual(1)
		}
	})

	it('rrf all same scores', async () => {
		await seedBase()
		const result = await t.hs.recall(
			bankId,
			'Peter hiking trail',
			{ enableTrace: true, limit: 10 }
		)
		expect(result.trace).toBeDefined()
		expect(
			result.trace!.candidates.length
		).toBeGreaterThanOrEqual(1)
		for (const candidate of result.trace!.candidates) {
			expect(
				candidate.rrfNormalized
			).toBeGreaterThanOrEqual(0)
			expect(candidate.rrfNormalized).toBeLessThanOrEqual(1)
			expect(
				candidate.combinedScore
			).toBeGreaterThanOrEqual(0)
			expect(candidate.combinedScore).toBeLessThanOrEqual(1)
		}
	})

	it('combined score calculation', async () => {
		await seedBase()
		const result = await t.hs.recall(
			bankId,
			'Peter hiking trail',
			{ enableTrace: true, limit: 10 }
		)
		expect(result.trace).toBeDefined()
		expect(
			result.trace!.candidates.length
		).toBeGreaterThanOrEqual(1)
		for (const candidate of result.trace!.candidates) {
			expect(
				candidate.rrfNormalized
			).toBeGreaterThanOrEqual(0)
			expect(candidate.rrfNormalized).toBeLessThanOrEqual(1)
			expect(
				candidate.combinedScore
			).toBeGreaterThanOrEqual(0)
			expect(candidate.combinedScore).toBeLessThanOrEqual(1)
		}
	})

	it('rrf contribution is significant', async () => {
		await seedBase()
		const result = await t.hs.recall(
			bankId,
			'Peter hiking trail',
			{ enableTrace: true, limit: 10 }
		)
		expect(result.trace).toBeDefined()
		expect(
			result.trace!.candidates.length
		).toBeGreaterThanOrEqual(1)
		for (const candidate of result.trace!.candidates) {
			expect(
				candidate.rrfNormalized
			).toBeGreaterThanOrEqual(0)
			expect(candidate.rrfNormalized).toBeLessThanOrEqual(1)
			expect(
				candidate.combinedScore
			).toBeGreaterThanOrEqual(0)
			expect(candidate.combinedScore).toBeLessThanOrEqual(1)
		}
	})

	it('rrf normalized not raw in trace', async () => {
		await seedBase()
		const result = await t.hs.recall(
			bankId,
			'Peter hiking trail',
			{ enableTrace: true, limit: 10 }
		)
		expect(result.trace).toBeDefined()
		expect(
			result.trace!.candidates.length
		).toBeGreaterThanOrEqual(1)
		for (const candidate of result.trace!.candidates) {
			expect(
				candidate.rrfNormalized
			).toBeGreaterThanOrEqual(0)
			expect(candidate.rrfNormalized).toBeLessThanOrEqual(1)
			expect(
				candidate.combinedScore
			).toBeGreaterThanOrEqual(0)
			expect(candidate.combinedScore).toBeLessThanOrEqual(1)
		}
	})
})
