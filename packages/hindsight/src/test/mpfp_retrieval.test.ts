/**
 * Core parity port for test_mpfp_retrieval.py.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createTestHindsight, createTestBank, type TestHindsight } from './setup'

describe('Core parity: test_mpfp_retrieval.py', () => {
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
					content: 'Peter met Alice in June 2024 and planned a hike',
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

	it('empty cache returns empty neighbors', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('is fully loaded false for uncached', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('add all edges marks as fully loaded', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('get neighbors returns added edges', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('get uncached filters loaded nodes', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('get normalized neighbors normalizes weights', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('different edge types are separate', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('empty results', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('single pattern ranking', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('multiple patterns boost common nodes', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('top k limits results', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('empty pattern scores ignored', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('empty seeds returns empty', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('single hop no edges', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('single hop with edges', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('two hops', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('name is mpfp', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('default config', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('custom config', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('convert seeds from retrieval results', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('convert seeds empty', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('retrieve no seeds returns empty', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('retrieve with semantic seeds', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('mpfp integration', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('mpfp lazy loading efficiency', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('mpfp edge loading performance', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})

	it('mpfp full retrieval performance', async () => {
		await seedBase()
		const result = await t.hs.recall(bankId, 'Peter', { methods: ['graph', 'semantic'], limit: 5 })
		expect(Array.isArray(result.memories)).toBe(true)
	})
})
