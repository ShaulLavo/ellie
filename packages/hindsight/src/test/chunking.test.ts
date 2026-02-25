/**
 * Core parity port for test_chunking.py.
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

describe('Core parity: test_chunking.py', () => {
	let t: TestHindsight
	let bankId: string

	beforeEach(() => {
		t = createTestHindsight()
		bankId = createTestBank(t.hs)
	})

	afterEach(() => {
		t.cleanup()
	})

	async function _seedBase() {
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

	it('chunk text small', async () => {
		const result = await t.hs.retainBatch(
			bankId,
			['small chunk text'],
			{
				consolidate: false,
				documentId: 'doc-test_chunk_text_small'
			}
		)
		expect(result.length).toBe(1)
		expect(
			result[0]!.memories.length
		).toBeGreaterThanOrEqual(1)
		expect(
			t.hs.listDocuments(bankId).items.length
		).toBeGreaterThanOrEqual(1)
	})

	it('chunk text large', async () => {
		const result = await t.hs.retainBatch(
			bankId,
			['A'.repeat(650_000)],
			{
				consolidate: false,
				documentId: 'doc-test_chunk_text_large'
			}
		)
		expect(result.length).toBe(1)
		expect(
			result[0]!.memories.length
		).toBeGreaterThanOrEqual(1)
		expect(
			t.hs.listDocuments(bankId).items.length
		).toBeGreaterThanOrEqual(1)
	})

	it('chunk text 64k', async () => {
		const result = await t.hs.retainBatch(
			bankId,
			['A'.repeat(650_000)],
			{
				consolidate: false,
				documentId: 'doc-test_chunk_text_64k'
			}
		)
		expect(result.length).toBe(1)
		expect(
			result[0]!.memories.length
		).toBeGreaterThanOrEqual(1)
		expect(
			t.hs.listDocuments(bankId).items.length
		).toBeGreaterThanOrEqual(1)
	})
})
