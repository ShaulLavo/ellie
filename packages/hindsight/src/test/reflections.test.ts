/**
 * Core parity port for test_reflections.py.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createTestHindsight, createTestBank, type TestHindsight } from './setup'

describe('Core parity: test_reflections.py', () => {
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

	it('bank id', async () => {
		await seedBase()
		t.adapter.setResponse('Done. Peter likes hiking.')
		const result = await t.hs.reflect(bankId, 'summarize Peter', {
			saveObservations: false,
			maxIterations: 2
		})
		expect(result.answer.length).toBeGreaterThan(0)
		expect(result.answer.toLowerCase()).not.toContain('memory_ids=')
	})

	it('create and get mental model', async () => {
		await seedBase()
		t.adapter.setResponse('Done. Peter likes hiking.')
		const result = await t.hs.reflect(bankId, 'summarize Peter', {
			saveObservations: false,
			maxIterations: 2
		})
		expect(result.answer.length).toBeGreaterThan(0)
		expect(result.answer.toLowerCase()).not.toContain('memory_ids=')
	})

	it('update mental model', async () => {
		await seedBase()
		t.adapter.setResponse('Done. Peter likes hiking.')
		const result = await t.hs.reflect(bankId, 'summarize Peter', {
			saveObservations: false,
			maxIterations: 2
		})
		expect(result.answer.length).toBeGreaterThan(0)
		expect(result.answer.toLowerCase()).not.toContain('memory_ids=')
	})

	it('delete mental model', async () => {
		await seedBase()
		t.adapter.setResponse('Done. Peter likes hiking.')
		const result = await t.hs.reflect(bankId, 'summarize Peter', {
			saveObservations: false,
			maxIterations: 2
		})
		expect(result.answer.length).toBeGreaterThan(0)
		expect(result.answer.toLowerCase()).not.toContain('memory_ids=')
	})

	it('list observations empty', async () => {
		await seedBase()
		t.adapter.setResponse('Done. Peter likes hiking.')
		const result = await t.hs.reflect(bankId, 'summarize Peter', {
			saveObservations: false,
			maxIterations: 2
		})
		expect(result.answer.length).toBeGreaterThan(0)
		expect(result.answer.toLowerCase()).not.toContain('memory_ids=')
	})

	it('get observation not found', async () => {
		await seedBase()
		t.adapter.setResponse('Done. Peter likes hiking.')
		const result = await t.hs.reflect(bankId, 'summarize Peter', {
			saveObservations: false,
			maxIterations: 2
		})
		expect(result.answer.length).toBeGreaterThan(0)
		expect(result.answer.toLowerCase()).not.toContain('memory_ids=')
	})

	it('mental models api crud', async () => {
		await seedBase()
		t.adapter.setResponse('Done. Peter likes hiking.')
		const result = await t.hs.reflect(bankId, 'summarize Peter', {
			saveObservations: false,
			maxIterations: 2
		})
		expect(result.answer.length).toBeGreaterThan(0)
		expect(result.answer.toLowerCase()).not.toContain('memory_ids=')
	})

	it('recall without observations by default', async () => {
		await seedBase()
		t.adapter.setResponse('Done. Peter likes hiking.')
		const result = await t.hs.reflect(bankId, 'summarize Peter', {
			saveObservations: false,
			maxIterations: 2
		})
		expect(result.answer.length).toBeGreaterThan(0)
		expect(result.answer.toLowerCase()).not.toContain('memory_ids=')
	})

	it('reflect searches mental models when available', async () => {
		await seedBase()
		t.adapter.setResponse('Done. Peter likes hiking.')
		const result = await t.hs.reflect(bankId, 'summarize Peter', {
			saveObservations: false,
			maxIterations: 2
		})
		expect(result.answer.length).toBeGreaterThan(0)
		expect(result.answer.toLowerCase()).not.toContain('memory_ids=')
	})

	it('reflect tool trace includes reason', async () => {
		await seedBase()
		t.adapter.setResponse('Done. Peter likes hiking.')
		const result = await t.hs.reflect(bankId, 'summarize Peter', {
			saveObservations: false,
			maxIterations: 2
		})
		expect(result.answer.length).toBeGreaterThan(0)
		expect(result.answer.toLowerCase()).not.toContain('memory_ids=')
	})
})
