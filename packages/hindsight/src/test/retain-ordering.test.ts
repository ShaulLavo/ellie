/**
 * Tests for fact ordering — temporal ordering within documents.
 *
 * Port of test_fact_ordering.py.
 */

import {
	describe,
	it,
	expect,
	beforeEach,
	afterEach
} from 'bun:test'
import {
	createTestBank,
	createTestHindsight,
	type TestHindsight
} from './setup'

describe('Fact ordering', () => {
	let t: TestHindsight
	let bankId: string

	beforeEach(() => {
		t = createTestHindsight()
		bankId = createTestBank(t.hs)
	})

	afterEach(() => {
		t.cleanup()
	})

	describe('temporal ordering within a conversation', () => {
		it('facts from same conversation maintain temporal order via mentionedAt', async () => {
			const eventDate = Date.now() - 10_000
			const result = await t.hs.retain(
				bankId,
				'conversation',
				{
					eventDate,
					facts: [
						{
							content: 'First statement in thread',
							factType: 'world'
						},
						{
							content: 'Second statement in thread',
							factType: 'world'
						},
						{
							content: 'Third statement in thread',
							factType: 'world'
						}
					],
					consolidate: false
				}
			)

			expect(result.memories).toHaveLength(3)
			const mentionedAts = result.memories.map(
				memory => memory.mentionedAt
			)
			expect(mentionedAts[0]).toBe(eventDate)
			expect(mentionedAts[1]).toBe(eventDate + 1)
			expect(mentionedAts[2]).toBe(eventDate + 2)
		})
	})

	describe('mentionedAt offsets', () => {
		it('each fact gets a unique mentionedAt offset and recall preserves temporal metadata', async () => {
			const eventDate = Date.now() - 20_000
			await t.hs.retain(bankId, 'ordering sample', {
				eventDate,
				facts: [
					{ content: 'Alpha event', factType: 'world' },
					{ content: 'Beta event', factType: 'world' },
					{ content: 'Gamma event', factType: 'world' }
				],
				consolidate: false
			})

			const recalled = await t.hs.recall(bankId, 'event', {
				methods: ['semantic', 'fulltext']
			})
			const mentionedAts = recalled.memories
				.map(memory => memory.memory.mentionedAt)
				.filter((value): value is number => value != null)

			expect(mentionedAts.length).toBeGreaterThan(0)
			expect(new Set(mentionedAts).size).toBe(
				mentionedAts.length
			)
			for (const value of mentionedAts) {
				expect(value).toBeGreaterThanOrEqual(eventDate)
			}
		})
	})

	describe('multiple documents ordering', () => {
		it('batch retain of multiple documents produces distinct mentionedAt ranges', async () => {
			const base = Date.now() - 60_000
			const result = await t.hs.retainBatch(
				bankId,
				[
					{
						content: 'Doc A fact one. Doc A fact two.',
						eventDate: base,
						documentId: 'doc-A'
					},
					{
						content: 'Doc B fact one. Doc B fact two.',
						eventDate: base + 10_000,
						documentId: 'doc-B'
					}
				],
				{ consolidate: false, dedupThreshold: 0 }
			)

			const docA = result[0]!.memories
				.map(memory => memory.mentionedAt)
				.filter((value): value is number => value != null)
			const docB = result[1]!.memories
				.map(memory => memory.mentionedAt)
				.filter((value): value is number => value != null)
			expect(docA.length).toBeGreaterThan(0)
			expect(docB.length).toBeGreaterThan(0)
			expect(Math.min(...docB)).toBeGreaterThan(
				Math.max(...docA)
			)
		})
	})
})
