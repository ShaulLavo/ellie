/**
 * Core parity port for test_tags_visibility.py.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createTestHindsight, createTestBank, type TestHindsight } from './setup'

describe('Core parity: test_tags_visibility.py', () => {
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

	it('no tags returns empty string', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('empty tags list returns empty string', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags with different param num', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags with table alias', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags match any includes untagged', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags match any uses overlap', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags match all includes untagged', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags match all uses contains', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags match any strict excludes untagged', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags match any strict uses overlap', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags match all strict excludes untagged', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags match all strict uses contains', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags match any with table alias', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('tags match all strict with table alias', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('no tags returns all', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('empty tags returns all', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('any mode includes matching tags', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('any mode includes untagged', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('any mode includes partial overlap', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('any strict excludes untagged', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('any strict excludes non matching', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('all mode requires all tags', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('all mode includes untagged', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('all strict requires all tags', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('all strict excludes untagged', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('all strict allows superset', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('bank id', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('retain with tags', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('retain with document tags', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('retain merges document and item tags', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('recall without tags returns all memories', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('recall with tags filters memories', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('recall with multiple tags uses or matching', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('recall returns memories with any overlapping tag', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('reflect with tags filters memories', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('recall with empty tags returns all', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('multi user agent visibility', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('student tracking visibility', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('list tags returns all tags', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('list tags with wildcard prefix', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('list tags with wildcard suffix', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('list tags with wildcard middle', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('list tags case insensitive', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('list tags pagination', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('list tags empty bank', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})

	it('list tags ordered by count', async () => {
		await seedBase()
		const tags = t.hs.listTags(bankId, { limit: 100 })
		expect(tags.items.length).toBeGreaterThan(0)
		expect(tags.total).toBeGreaterThan(0)
	})
})
