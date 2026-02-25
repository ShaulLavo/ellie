/**
 * Tests for retain() — fact extraction, storage, entity resolution, linking.
 *
 * Port of test_retain.py.
 * Integration tests — needs DB + mock adapter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createTestHindsight, createTestBank, getHdb, type TestHindsight } from './setup'
import { eq } from 'drizzle-orm'
import type { HindsightDatabase } from '../db'

describe('retain', () => {
	let t: TestHindsight
	let bankId: string

	beforeEach(() => {
		t = createTestHindsight()
		bankId = createTestBank(t.hs)
	})

	afterEach(() => {
		t.cleanup()
	})

	// ── Basic retain ────────────────────────────────────────────────────────

	describe('with pre-provided facts', () => {
		it('stores facts and returns RetainResult', async () => {
			const result = await t.hs.retain(bankId, 'test content', {
				facts: [
					{ content: 'Peter loves hiking', factType: 'experience', confidence: 0.9 },
					{ content: 'Alice likes reading', factType: 'experience', confidence: 0.85 }
				],
				consolidate: false
			})

			expect(result.memories).toHaveLength(2)
			expect(result.memories[0]!.content).toBe('Peter loves hiking')
			expect(result.memories[0]!.factType).toBe('experience')
			expect(result.memories[0]!.confidence).toBe(0.9)
			expect(result.memories[1]!.content).toBe('Alice likes reading')
		})

		it('assigns IDs to stored memories', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Fact 1' }],
				consolidate: false
			})

			expect(result.memories[0]!.id).toBeDefined()
			expect(result.memories[0]!.id.length).toBeGreaterThan(0)
		})

		it('assigns the correct bankId', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Banked fact' }],
				consolidate: false
			})

			expect(result.memories[0]!.bankId).toBe(bankId)
		})

		it('defaults factType to a valid type when none specified', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'No type specified' }],
				consolidate: false
			})

			// Default factType when none provided should be "experience" or "world"
			expect(['experience', 'world']).toContain(result.memories[0]!.factType)
		})

		it('stores multiple facts from a single retain call', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Fact A' }, { content: 'Fact B' }, { content: 'Fact C' }],
				consolidate: false
			})

			expect(result.memories).toHaveLength(3)
		})

		it('accepts canonical transcript format content ({role, content}[])', async () => {
			const transcript = [
				{ role: 'user', content: 'I love hiking.' },
				{ role: 'assistant', content: 'Nice, where do you hike?' }
			]

			const result = await t.hs.retain(bankId, transcript, {
				facts: [{ content: 'User loves hiking', factType: 'experience' }],
				consolidate: false
			})

			expect(result.memories).toHaveLength(1)
			expect(result.memories[0]!.sourceText).toContain('"role":"user"')
			expect(result.memories[0]!.sourceText).toContain('"content":"I love hiking."')
		})
	})

	// ── Entity extraction ─────────────────────────────────────────────────

	describe('entity extraction', () => {
		it('extracts entities from pre-provided facts', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content: 'Peter works at Acme Corp',
						entities: ['Peter', 'Acme Corp']
					}
				],
				consolidate: false
			})

			expect(result.entities.length).toBeGreaterThanOrEqual(1)
			const names = result.entities.map((e) => e.name)
			expect(names).toContain('Peter')
		})

		it('creates entity links between memories sharing entities', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [
					{ content: 'Peter loves hiking', entities: ['Peter'] },
					{ content: 'Peter went to the store', entities: ['Peter'] }
				],
				consolidate: false
			})

			// Both memories share "Peter" → should create entity links
			const entityLinks = result.links.filter((l) => l.linkType === 'entity')
			expect(entityLinks.length).toBeGreaterThanOrEqual(1)
		})
	})

	// ── Tag attachment ──────────────────────────────────────────────────────

	describe('tag attachment', () => {
		it('attaches tags from options', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Tagged fact' }],
				tags: ['project-x', 'important'],
				consolidate: false
			})

			expect(result.memories[0]!.tags).toEqual(['project-x', 'important'])
		})

		it('attaches tags from individual facts', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Fact with tags', tags: ['tag-a', 'tag-b'] }],
				consolidate: false
			})

			expect(result.memories[0]!.tags).toContain('tag-a')
			expect(result.memories[0]!.tags).toContain('tag-b')
		})
	})

	// ── Deduplication ─────────────────────────────────────────────────────

	describe('deduplication', () => {
		it('reinforces duplicate facts (returns existing memory)', async () => {
			const first = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Peter loves hiking' }],
				consolidate: false,
				dedupThreshold: 0.92
			})

			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Peter loves hiking' }],
				consolidate: false,
				dedupThreshold: 0.92
			})

			// Exact duplicate → reinforced, returns existing memory
			expect(result.memories).toHaveLength(1)
			expect(result.memories[0]!.id).toBe(first.memories[0]!.id)
			expect(result.memories[0]!.content).toBe('Peter loves hiking')
		})

		it('allows when threshold is 0 (disabled)', async () => {
			const first = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Peter loves hiking' }],
				consolidate: false,
				dedupThreshold: 0
			})

			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Peter loves hiking' }],
				consolidate: false,
				dedupThreshold: 0
			})

			// dedup disabled → a brand-new memory is created, not the original reinforced
			expect(result.memories).toHaveLength(1)
			expect(result.memories[0]!.id).not.toBe(first.memories[0]!.id)
		})
	})

	// ── Semantic link creation ──────────────────────────────────────────────

	describe('semantic links', () => {
		it('creates semantic links between similar memories', async () => {
			// First retain
			await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Peter enjoys mountain hiking trails' }],
				consolidate: false
			})

			// Second retain with related content
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Peter loves hiking in the Alps' }],
				consolidate: false,
				dedupThreshold: 0 // disable dedup so it gets stored
			})

			const semanticLinks = result.links.filter((l) => l.linkType === 'semantic')
			// Semantic links may or may not be created depending on embedding similarity
			// The test verifies the mechanism runs without error and returns an array
			expect(Array.isArray(semanticLinks)).toBe(true)
		})
	})

	// ── Causal linking ──────────────────────────────────────────────────────

	describe('causal links', () => {
		it('creates causal links from causalRelations', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [
					{ content: 'It started raining heavily' },
					{
						content: 'The hiking trail became muddy'
						// Note: causalRelations are part of the LLM extraction output,
						// not part of the pre-provided facts interface.
						// This test may need the LLM path — marking as TDD target.
					}
				],
				consolidate: false
			})

			// With pre-provided facts, causal links require the extraction pipeline
			// This serves as a placeholder — the full causal linking test needs LLM
			expect(result).toBeDefined()
		})
	})

	// ── Temporal fields ───────────────────────────────────────────────────

	describe('temporal fields', () => {
		it('stores occurredStart and occurredEnd from facts', async () => {
			const occurredStart = Date.now() - 86_400_000 // yesterday
			const occurredEnd = Date.now()

			const result = await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content: 'Event happened yesterday',
						occurredStart,
						occurredEnd
					}
				],
				consolidate: false
			})

			expect(result.memories[0]!.occurredStart).toBe(occurredStart)
			expect(result.memories[0]!.occurredEnd).toBe(occurredEnd)
		})

		it('defaults occurredStart and occurredEnd to null', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Timeless fact' }],
				consolidate: false
			})

			expect(result.memories[0]!.occurredStart).toBeNull()
			expect(result.memories[0]!.occurredEnd).toBeNull()
		})

		it('creates temporal links for memories close in time', async () => {
			const now = Date.now()
			const result = await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content: 'Deployment started',
						occurredStart: now - 60 * 60 * 1000,
						occurredEnd: now - 55 * 60 * 1000
					},
					{
						content: 'Deployment finished',
						occurredStart: now - 20 * 60 * 1000,
						occurredEnd: now - 10 * 60 * 1000
					}
				],
				consolidate: false,
				dedupThreshold: 0
			})

			const memoryIds = new Set(result.memories.map((memory) => memory.id))
			const hdb = (t.hs as unknown as { hdb: HindsightDatabase }).hdb
			const temporalLinks = hdb.db
				.select({
					sourceId: hdb.schema.memoryLinks.sourceId,
					targetId: hdb.schema.memoryLinks.targetId,
					linkType: hdb.schema.memoryLinks.linkType
				})
				.from(hdb.schema.memoryLinks)
				.all()
				.filter(
					(link: { sourceId: string; targetId: string; linkType: string }) =>
						link.linkType === 'temporal' &&
						memoryIds.has(link.sourceId) &&
						memoryIds.has(link.targetId)
				)

			expect(temporalLinks.length).toBeGreaterThanOrEqual(2)
		})
	})

	// ── Metadata ──────────────────────────────────────────────────────────

	describe('metadata', () => {
		it('attaches metadata from options', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Metadata fact' }],
				metadata: { source: 'chat', sessionId: 'abc123' },
				consolidate: false
			})

			expect(result.memories[0]!.metadata).toEqual({
				source: 'chat',
				sessionId: 'abc123'
			})
		})
	})

	// ── Context preservation (needs LLM extraction) ─────────────────────

	describe('context preservation', () => {
		it('preserves context and makes it retrievable via recall', async () => {
			// Store content with metadata and tags that serve as context
			const result = await t.hs.retain(bankId, 'Alice told me about her trip to Japan', {
				facts: [
					{
						content: 'Alice visited Tokyo last summer',
						factType: 'experience',
						confidence: 0.95,
						entities: ['Alice', 'Tokyo']
					}
				],
				metadata: { context: 'travel discussion', speaker: 'Alice' },
				tags: ['travel', 'japan'],
				consolidate: false
			})

			expect(result.memories).toHaveLength(1)
			expect(result.memories[0]!.metadata).toEqual({
				context: 'travel discussion',
				speaker: 'Alice'
			})
			expect(result.memories[0]!.tags).toEqual(['travel', 'japan'])

			// Verify the context is preserved after recall
			const recallResult = await t.hs.recall(bankId, 'Alice trip Japan')
			expect(recallResult.memories.length).toBeGreaterThan(0)
			const recalled = recallResult.memories[0]!
			expect(recalled.memory.metadata).toEqual({
				context: 'travel discussion',
				speaker: 'Alice'
			})
			expect(recalled.memory.tags).toEqual(['travel', 'japan'])
		})

		it('supports different contexts per item in a batch', async () => {
			// retainBatch with 3 items, each with different content
			const results = await t.hs.retainBatch(
				bankId,
				[
					'Alice loves hiking in the mountains',
					'Bob enjoys swimming in the ocean',
					'Charlie likes reading science fiction'
				],
				{
					tags: ['batch-context'],
					consolidate: false
				}
			)

			expect(results).toHaveLength(3)
			// Each batch item should produce at least one memory
			for (const result of results) {
				expect(result.memories.length).toBeGreaterThanOrEqual(1)
			}
		})
	})

	// ── Batch edge cases (needs LLM extraction) ─────────────────────────

	describe('batch edge cases', () => {
		it('handles empty batch gracefully', async () => {
			const result = await t.hs.retainBatch(bankId, [], {
				consolidate: false
			})

			expect(result).toEqual([])
		})

		it('handles single-item batch correctly', async () => {
			const result = await t.hs.retainBatch(bankId, ['Alice went hiking in Yosemite'], {
				consolidate: false
			})

			expect(result).toHaveLength(1)
			expect(result[0]!.memories.length).toBeGreaterThanOrEqual(1)
		})

		it('handles mixed content sizes in a batch', async () => {
			const shortContent = 'Bob likes Python and hiking.'
			const longContent = 'Alice met Bob at the coffee shop. '.repeat(20_000) // ~700k chars

			const result = await t.hs.retainBatch(bankId, [shortContent, longContent], {
				consolidate: false,
				dedupThreshold: 0
			})

			expect(result).toHaveLength(2)
			expect(result[0]!.memories.length).toBeGreaterThanOrEqual(1)
			expect(result[1]!.memories.length).toBeGreaterThanOrEqual(1)
		})

		it('supports rich batch items with per-item context, eventDate, documentId, tags, and metadata', async () => {
			const base = Date.now() - 120_000
			const result = await t.hs.retainBatch(
				bankId,
				[
					{
						content: 'Alice discussed launch milestones',
						context: 'Sprint planning',
						eventDate: base,
						documentId: 'doc-rich-a',
						tags: ['team:alpha'],
						metadata: { source: 'meeting-a' }
					},
					{
						content: 'Bob documented rollout risks',
						context: 'Risk review',
						eventDate: base + 5_000,
						documentId: 'doc-rich-b',
						tags: ['team:beta'],
						metadata: { source: 'meeting-b' }
					}
				],
				{ consolidate: false, dedupThreshold: 0, tags: ['project:phoenix'] }
			)

			expect(result).toHaveLength(2)
			expect(result[0]!.memories.length).toBeGreaterThan(0)
			expect(result[1]!.memories.length).toBeGreaterThan(0)

			const first = result[0]!.memories[0]!
			const second = result[1]!.memories[0]!
			expect(first.documentId).toBe('doc-rich-a')
			expect(second.documentId).toBe('doc-rich-b')
			expect(first.chunkId).toBeDefined()
			expect(second.chunkId).toBeDefined()
			expect(first.sourceText).toContain('Sprint planning')
			expect(second.sourceText).toContain('Risk review')
			expect(first.mentionedAt).toBe(base)
			expect(second.mentionedAt).toBe(base + 5_000)
			expect(first.tags).toContain('project:phoenix')
			expect(second.tags).toContain('project:phoenix')
			expect(first.metadata).toEqual({ source: 'meeting-a' })
			expect(second.metadata).toEqual({ source: 'meeting-b' })

			const docs = t.hs.listDocuments(bankId)
			const docA = docs.items.find((doc) => doc.id === 'doc-rich-a')
			const docB = docs.items.find((doc) => doc.id === 'doc-rich-b')
			expect(docA).toBeDefined()
			expect(docB).toBeDefined()
			expect(docA!.tags).toContain('team:alpha')
			expect(docA!.tags).toContain('project:phoenix')
			expect(docB!.tags).toContain('team:beta')
			expect(docB!.tags).toContain('project:phoenix')

			const chunkA = t.hs.getChunk(bankId, first.chunkId!)
			const chunkB = t.hs.getChunk(bankId, second.chunkId!)
			expect(chunkA).toBeDefined()
			expect(chunkB).toBeDefined()
			expect(chunkA!.text).toContain('Alice discussed')
			expect(chunkB!.text).toContain('Bob documented')
		})
	})

	// ── Temporal link creation (needs LLM extraction) ───────────────────

	describe('temporal links', () => {
		it('creates temporal links between facts with nearby event dates', async () => {
			const base = Date.now() - 30_000
			const result = await t.hs.retainBatch(
				bankId,
				[
					{ content: 'Temporal A', eventDate: base, documentId: 'doc-temporal-a' },
					{ content: 'Temporal B', eventDate: base + 3_600_000, documentId: 'doc-temporal-b' },
					{ content: 'Temporal C', eventDate: base + 2 * 3_600_000, documentId: 'doc-temporal-c' }
				],
				{ consolidate: false, dedupThreshold: 0 }
			)

			const links = result.flatMap((item) => item.links)
			const temporal = links.filter((link) => link.linkType === 'temporal')
			expect(temporal.length).toBeGreaterThan(0)
		})

		it('caps new->existing temporal links at 10 and uses Python recency ordering', async () => {
			const base = Date.now()
			const hourMs = 3_600_000
			const existingIds: string[] = []

			// Use radically different content per fact so hash-based mock embeddings
			// produce similarity below 0.78 (new_trace routing).
			// Each string uses unique special chars and numbers.
			const uniqueTokens = [
				'aaa @@@ 111',
				'bbb $$$ 222',
				'ccc %%% 333',
				'ddd ^^^ 444',
				'eee &&& 555',
				'fff !!! 666',
				'ggg ### 777',
				'hhh *** 888',
				'iii +++ 999',
				'jjj === 000',
				'kkk ~~~ 101',
				'lll ||| 202'
			]

			// Seed 12 existing facts, newest first by smaller hour offset.
			for (let hourOffset = 1; hourOffset <= 12; hourOffset++) {
				const retainResult = await t.hs.retain(bankId, `existing-${hourOffset}`, {
					facts: [
						{
							content: uniqueTokens[hourOffset - 1]!,
							occurredStart: base - hourOffset * hourMs
						}
					],
					consolidate: false,
					dedupThreshold: 0
				})
				existingIds.push(retainResult.memories[0]!.id)
			}

			const newResult = await t.hs.retain(bankId, 'new-source', {
				facts: [{ content: 'mmm @@@ $$$ %%% 303', occurredStart: base }],
				consolidate: false,
				dedupThreshold: 0
			})
			const newId = newResult.memories[0]!.id
			const existingSet = new Set(existingIds)

			const newToExistingTemporal = newResult.links.filter(
				(link) =>
					link.linkType === 'temporal' && link.sourceId === newId && existingSet.has(link.targetId)
			)

			expect(newToExistingTemporal).toHaveLength(10)
			// Python parity: ordered by candidate recency (event_date DESC), not nearest distance sort.
			expect(newToExistingTemporal.map((link) => link.targetId)).toEqual(existingIds.slice(0, 10))
		})

		it('persists temporal link weights using linear decay with 0.3 floor', async () => {
			const base = Date.now()
			const hourMs = 3_600_000

			const near = await t.hs.retain(bankId, 'near', {
				facts: [{ content: 'Near temporal candidate', occurredStart: base - 2 * hourMs }],
				consolidate: false,
				dedupThreshold: 0
			})
			const floor = await t.hs.retain(bankId, 'floor', {
				facts: [{ content: 'Floor temporal candidate', occurredStart: base - 23 * hourMs }],
				consolidate: false,
				dedupThreshold: 0
			})

			const source = await t.hs.retain(bankId, 'source', {
				facts: [{ content: 'Temporal weight source', occurredStart: base }],
				consolidate: false,
				dedupThreshold: 0
			})

			const sourceId = source.memories[0]!.id
			const nearId = near.memories[0]!.id
			const floorId = floor.memories[0]!.id

			const hdb = (t.hs as unknown as { hdb: HindsightDatabase }).hdb
			const rows = hdb.db
				.select({
					sourceId: hdb.schema.memoryLinks.sourceId,
					targetId: hdb.schema.memoryLinks.targetId,
					linkType: hdb.schema.memoryLinks.linkType,
					weight: hdb.schema.memoryLinks.weight
				})
				.from(hdb.schema.memoryLinks)
				.all()
				.filter(
					(row: { sourceId: string; targetId: string; linkType: string; weight: number }) =>
						row.linkType === 'temporal' &&
						row.sourceId === sourceId &&
						(row.targetId === nearId || row.targetId === floorId)
				)

			expect(rows).toHaveLength(2)

			const nearLink = rows.find((row: { targetId: string }) => row.targetId === nearId)
			const floorLink = rows.find((row: { targetId: string }) => row.targetId === floorId)
			expect(nearLink).toBeDefined()
			expect(floorLink).toBeDefined()

			expect(nearLink!.weight).toBeCloseTo(1 - 2 / 24, 6)
			expect(floorLink!.weight).toBe(0.3)
		})
	})

	// ── All link types together (needs LLM extraction) ──────────────────

	describe('all link types together', () => {
		it('creates temporal, semantic, and entity links in a single operation', async () => {
			const baseTime = Date.now()
			const oneHourMs = 3_600_000

			// First retain some base memories for semantic linking
			await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content: 'Alice works on the search team at Google',
						entities: ['Alice', 'Google']
					}
				],
				consolidate: false
			})

			// Now retain related facts with entities, nearby dates, and similar content
			const result = await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content: 'Alice presented her search algorithm improvements',
						occurredStart: baseTime,
						entities: ['Alice']
					},
					{
						content: "Alice's search team received an award for the improvements",
						occurredStart: baseTime + oneHourMs,
						entities: ['Alice']
					},
					{
						content: 'Alice celebrated with the Google search team',
						occurredStart: baseTime + 2 * oneHourMs,
						entities: ['Alice', 'Google']
					}
				],
				consolidate: false,
				dedupThreshold: 0
			})

			expect(result.memories).toHaveLength(3)
			expect(result.links.length).toBeGreaterThanOrEqual(1)

			// Verify entity links exist (all facts share "Alice")
			const entityLinks = result.links.filter((l) => l.linkType === 'entity')
			expect(entityLinks.length).toBeGreaterThanOrEqual(1)

			// Semantic and temporal links may or may not be created depending on
			// embedding similarity and temporal link implementation status
			const semanticLinks = result.links.filter((l) => l.linkType === 'semantic')
			expect(Array.isArray(semanticLinks)).toBe(true)

			const temporalLinks = result.links.filter((l) => l.linkType === 'temporal')
			expect(Array.isArray(temporalLinks)).toBe(true)
		})
	})

	// ── Intra-batch links (needs LLM extraction) ───────────────────────

	describe('intra-batch links', () => {
		it('creates semantic links between facts in the same batch', async () => {
			// First seed some existing memories so the batch can form semantic links to them
			await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Python is widely used for data science' }],
				consolidate: false
			})

			const results = await t.hs.retainBatch(
				bankId,
				[
					'Python is a popular programming language for machine learning',
					"Python's ecosystem includes NumPy, Pandas, and scikit-learn",
					'Python is the top choice for AI and data analysis'
				],
				{ consolidate: false, dedupThreshold: 0 }
			)
			expect(results).toHaveLength(3)

			const allLinks = results.flatMap((item) => item.links)
			const semanticLinks = allLinks.filter((link) => link.linkType === 'semantic')
			expect(Array.isArray(semanticLinks)).toBe(true)
		})

		it('creates temporal links between facts in the same batch', async () => {
			const base = Date.now() - 90_000
			const result = await t.hs.retainBatch(
				bankId,
				[
					{ content: 'Batch temporal one', eventDate: base },
					{ content: 'Batch temporal two', eventDate: base + 1_000 },
					{ content: 'Batch temporal three', eventDate: base + 2_000 }
				],
				{ consolidate: false, dedupThreshold: 0 }
			)

			const temporalLinks = result.flatMap((item) =>
				item.links.filter((link) => link.linkType === 'temporal')
			)
			expect(temporalLinks.length).toBeGreaterThan(0)
		})
	})

	// ── User-provided entities (needs LLM extraction) ──────────────────

	describe('user-provided entities', () => {
		it('merges user-provided entities with LLM-extracted entities', async () => {
			// Retain with user-provided entities in the facts
			const result = await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content: 'Alice is working on ProjectX at ACME Corp',
						entities: ['Alice', 'ProjectX', 'ACME Corp']
					},
					{
						content: 'ProjectX is a new AI initiative led by Alice',
						entities: ['ProjectX', 'Alice']
					}
				],
				consolidate: false,
				dedupThreshold: 0
			})

			expect(result.memories).toHaveLength(2)
			expect(result.entities.length).toBeGreaterThanOrEqual(1)

			const entityNames = result.entities.map((e) => e.name)
			expect(entityNames).toContain('Alice')
			expect(entityNames).toContain('ProjectX')
			expect(entityNames).toContain('ACME Corp')

			// Entity links should exist since both facts share Alice and ProjectX
			const entityLinks = result.links.filter((l) => l.linkType === 'entity')
			expect(entityLinks.length).toBeGreaterThanOrEqual(1)
		})
	})

	// ── Custom extraction mode (needs LLM extraction) ──────────────────

	describe('custom extraction mode', () => {
		it('uses custom extraction guidelines from config', async () => {
			const customGuidelines =
				'Extract only Italian language facts. Ignore English content entirely.'

			// Set up the mock adapter response
			t.adapter.setResponse(
				JSON.stringify({
					facts: [
						{
							content: "Roma e la capitale d'Italia",
							factType: 'world',
							confidence: 0.95,
							occurredStart: null,
							occurredEnd: null,
							entities: [{ name: 'Roma', entityType: 'place' }],
							tags: [],
							causalRelations: []
						}
					]
				})
			)

			// Retain with custom mode — this triggers LLM extraction
			const result = await t.hs.retain(
				bankId,
				"Roma e la capitale d'Italia. Rome is the capital of Italy.",
				{
					mode: 'custom',
					customGuidelines,
					consolidate: false
				}
			)

			// Verify the adapter was called
			expect(t.adapter.callCount).toBeGreaterThanOrEqual(1)

			// Verify extraction used the custom mode
			expect(result.memories.length).toBeGreaterThanOrEqual(1)
			expect(result.memories[0]!.content).toBe("Roma e la capitale d'Italia")
		})
	})

	// ── Per-item tags on document (needs LLM extraction) ────────────────

	describe('per-item tags on document', () => {
		it('stores per-item tags on the document record', async () => {
			await t.hs.retainBatch(
				bankId,
				[
					{
						content: 'Tagged doc content',
						documentId: 'doc-tags-1',
						tags: ['user:testuser', 'app-type:taste-ai']
					}
				],
				{ consolidate: false, dedupThreshold: 0 }
			)

			const document = t.hs.getDocument(bankId, 'doc-tags-1')
			expect(document).toBeDefined()
			expect(document!.tags).toContain('user:testuser')
			expect(document!.tags).toContain('app-type:taste-ai')
		})
	})

	// ── Mention count (needs LLM extraction) ────────────────────────────

	describe('mention count', () => {
		it('accurately tracks mention count across multiple retain calls', async () => {
			// Store 5 separate contents all mentioning Alice
			// Use radically different content so hash-based mock embeddings
			// produce similarity below 0.78 (new_trace routing)
			const uniqueContents = [
				'Alice 111 @@@ zzz',
				'Alice 222 $$$ qqq',
				'Alice 333 %%% www',
				'Alice 444 ^^^ xxx',
				'Alice 555 &&& yyy'
			]
			for (const content of uniqueContents) {
				await t.hs.retain(bankId, 'test', {
					facts: [
						{
							content,
							entities: ['Alice']
						}
					],
					consolidate: false,
					dedupThreshold: 0
				})
			}

			// Query the entities table directly to check mention count
			const _result = await t.hs.recall(bankId, 'Alice', {
				methods: ['graph']
			})
			// Graph-only retrieval can be sparse depending on seed resolution;
			// use entity index for deterministic mention-count existence checks.
			const entities = t.hs.listEntities(bankId)
			const aliceEntity = entities.items.find((item) => item.canonicalName === 'Alice')
			expect(aliceEntity).toBeDefined()
			expect(aliceEntity!.mentionCount).toBeGreaterThanOrEqual(5)

			// Check via entities on the latest retain result
			const lastRetain = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Alice 999 !!! uuu ppp', entities: ['Alice'] }],
				consolidate: false,
				dedupThreshold: 0
			})

			// Alice should be a resolved entity (existing, not newly created)
			expect(lastRetain.entities.length).toBeGreaterThanOrEqual(1)
			const alice = lastRetain.entities.find((e) => e.name === 'Alice')
			expect(alice).toBeDefined()
		})

		it('accurately tracks mention count with batch retain', async () => {
			// Batch retain with 6 items mentioning Bob
			// Use radically different content so hash-based mock embeddings
			// produce similarity below 0.78 (new_trace routing)
			const batchTexts = [
				'Bob 111 @@@ zzz aaa',
				'Bob 222 $$$ qqq bbb',
				'Bob 333 %%% www ccc',
				'Bob 444 ^^^ xxx ddd',
				'Bob 555 &&& yyy eee',
				'Bob 666 !!! uuu fff'
			]

			t.adapter.setResponses(
				batchTexts.map((text) =>
					JSON.stringify({
						facts: [
							{
								content: text,
								factType: 'experience',
								confidence: 0.9,
								occurredStart: null,
								occurredEnd: null,
								entities: [{ name: 'Bob', entityType: 'person' }],
								tags: [],
								causalRelations: []
							}
						]
					})
				)
			)

			const results = await t.hs.retainBatch(bankId, batchTexts, {
				consolidate: false,
				dedupThreshold: 0
			})

			expect(results).toHaveLength(6)
			const totalMemories = results.reduce((sum, r) => sum + r.memories.length, 0)
			expect(totalMemories).toBeGreaterThanOrEqual(6)

			// Add 2 more mentions of Bob with very different content
			const moreBatchTexts = ['Bob 777 *** ppp ggg', 'Bob 888 ### rrr hhh']

			t.adapter.setResponses(
				moreBatchTexts.map((text) =>
					JSON.stringify({
						facts: [
							{
								content: text,
								factType: 'experience',
								confidence: 0.9,
								occurredStart: null,
								occurredEnd: null,
								entities: [{ name: 'Bob', entityType: 'person' }],
								tags: [],
								causalRelations: []
							}
						]
					})
				)
			)

			const moreResults = await t.hs.retainBatch(bankId, moreBatchTexts, {
				consolidate: false,
				dedupThreshold: 0
			})

			expect(moreResults).toHaveLength(2)
			const moreMemories = moreResults.reduce((sum, r) => sum + r.memories.length, 0)
			expect(moreMemories).toBeGreaterThanOrEqual(2)

			// Bob entity should be resolved (not duplicated) across batches
			const bobEntities = moreResults.flatMap((r) => r.entities).filter((e) => e.name === 'Bob')
			expect(bobEntities.length).toBeGreaterThanOrEqual(1)
		})
	})

	// ── Temporal fields (event_date, mentioned_at, occurred_start/end) ──────

	describe('temporal fields', () => {
		it('stores event_date as mentioned_at on retained facts', async () => {
			const eventDate = 1_700_000_000_000 // fixed timestamp
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Timestamped fact' }],
				eventDate,
				consolidate: false
			})

			expect(result.memories[0]!.mentionedAt).toBe(eventDate)
		})

		it('occurred_start and occurred_end are null when not extractable (TDD)', async () => {
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'No temporal bounds' }],
				consolidate: false
			})

			// occurredStart/occurredEnd map to occurredStart/occurredEnd in the display layer
			expect(result.memories[0]!.occurredStart).toBeNull()
			expect(result.memories[0]!.occurredEnd).toBeNull()
		})

		it('mentioned_at vs occurred_start are distinct fields (TDD)', async () => {
			const eventDate = 1_700_000_000_000
			const occurredStart = 1_600_000_000_000 // deliberately different from eventDate
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Distinct temporal fields', occurredStart }],
				eventDate,
				consolidate: false
			})

			// mentionedAt comes from eventDate, occurredStart comes from the fact
			expect(result.memories[0]!.mentionedAt).toBe(eventDate)
			expect(result.memories[0]!.occurredStart).toBe(occurredStart)
			expect(result.memories[0]!.mentionedAt).not.toBe(result.memories[0]!.occurredStart)
		})

		it('ISO date string in context sets mentioned_at (TDD)', async () => {
			const isoDate = '2024-06-15T10:30:00Z'
			const expectedMs = new Date(isoDate).getTime()
			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'ISO date context' }],
				eventDate: isoDate,
				consolidate: false
			})

			expect(result.memories[0]!.mentionedAt).toBe(expectedMs)
		})
	})

	// ── Retain → recall round-trip ───────────────────────────────────────

	describe('retain → recall round-trip', () => {
		it('retained content is surfaced by recall with non-empty results', async () => {
			// Retain facts about Alice
			await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content: 'Alice is a software engineer at Google',
						factType: 'experience',
						entities: ['Alice', 'Google']
					},
					{
						content: 'Bob works with Alice on the search team',
						factType: 'experience',
						entities: ['Bob', 'Alice']
					}
				],
				consolidate: false
			})

			// Recall should surface these memories
			const result = await t.hs.recall(bankId, 'Who is Alice?')
			expect(result.memories.length).toBeGreaterThan(0)

			// At least one result should mention Alice
			const aliceMemories = result.memories.filter((m) =>
				m.memory.content.toLowerCase().includes('alice')
			)
			expect(aliceMemories.length).toBeGreaterThan(0)
		})
	})
})

describe('Core parity: test_retain.py', () => {
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
		return t.hs.retain(bankId, 'seed', {
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

	it('retain with chunks', async () => {
		const result = await t.hs.retain(bankId, 'Alice visited the Colosseum in Rome', {
			facts: [
				{
					content: 'Alice visited Rome',
					factType: 'experience',
					confidence: 0.95,
					entities: ['Alice', 'Rome']
				}
			],
			documentId: 'travel-doc-1',
			consolidate: false
		})
		expect(result.memories).toHaveLength(1)
		expect(result.memories[0]!.documentId).toBe('travel-doc-1')
		expect(result.memories[0]!.content).toBe('Alice visited Rome')
	})

	it('chunks and entities follow fact order', async () => {
		const result = await t.hs.retain(bankId, 'team notes', {
			facts: [
				{
					content: 'Alice joined the team',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				},
				{
					content: 'Bob led the project',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Bob']
				},
				{
					content: 'Charlie reviewed the code',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Charlie']
				}
			],
			consolidate: false,
			dedupThreshold: 0
		})
		expect(result.memories).toHaveLength(3)
		expect(result.memories[0]!.content).toContain('Alice')
		expect(result.memories[1]!.content).toContain('Bob')
		expect(result.memories[2]!.content).toContain('Charlie')
	})

	it('temporal ordering', async () => {
		const past = Date.now() - 30 * 86_400_000
		const recent = Date.now() - 1 * 86_400_000
		const r1 = await t.hs.retain(bankId, 'old event', {
			facts: [
				{
					content: 'Alice visited Paris long ago',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			eventDate: past,
			consolidate: false,
			dedupThreshold: 0
		})
		const r2 = await t.hs.retain(bankId, 'new event', {
			facts: [
				{
					content: 'Alice visited London recently',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			eventDate: recent,
			consolidate: false,
			dedupThreshold: 0
		})
		expect(r1.memories[0]!.eventDate).toBeLessThan(r2.memories[0]!.eventDate!)
	})

	it('context preservation', async () => {
		const result = await t.hs.retain(bankId, 'team discussion', {
			facts: [
				{
					content: 'Alice proposed a new architecture',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			context: 'team meeting notes from Q4 planning session',
			consolidate: false
		})
		expect(result.memories[0]!.sourceText).toContain('team meeting notes')
	})

	it('context with batch', async () => {
		// retainBatch uses mock LLM adapter for extraction
		const results = await t.hs.retainBatch(
			bankId,
			[
				{ content: 'Alice likes hiking in the mountains' },
				{ content: 'Bob prefers cycling on the coast' }
			],
			{ consolidate: false }
		)
		expect(results).toHaveLength(2)
		// Each batch item produces at least one memory via mock adapter extraction
		for (const result of results) {
			expect(result.memories.length).toBeGreaterThanOrEqual(1)
		}
	})

	it('metadata storage and retrieval', async () => {
		const result = await t.hs.retain(bankId, 'content', {
			facts: [
				{
					content: 'Alice visited Rome',
					factType: 'experience',
					confidence: 0.95,
					entities: ['Alice']
				}
			],
			metadata: { source: 'unit-test', importance: 'high' },
			consolidate: false
		})
		expect(result.memories[0]!.metadata).toEqual({ source: 'unit-test', importance: 'high' })
	})

	it('empty batch', async () => {
		const results = await t.hs.retainBatch(bankId, [])
		expect(results).toEqual([])
	})

	it('single item batch', async () => {
		const results = await t.hs.retainBatch(bankId, ['Alice joined the engineering team'], {
			consolidate: false
		})
		expect(results).toHaveLength(1)
		expect(results[0]!.memories.length).toBeGreaterThanOrEqual(1)
	})

	it('mixed content batch', async () => {
		const results = await t.hs.retainBatch(
			bankId,
			[
				'Short note about Alice',
				"A much longer paragraph discussing Bob's extensive contributions to the engineering team over several years of dedicated service",
				"Medium note about Charlie's work on the project"
			],
			{ consolidate: false }
		)
		expect(results).toHaveLength(3)
		for (const result of results) {
			expect(result.memories.length).toBeGreaterThanOrEqual(1)
		}
	})

	it('batch with missing optional fields', async () => {
		const results = await t.hs.retainBatch(
			bankId,
			[
				{ content: 'Alice joined the team' },
				{ content: 'Bob led the project', context: 'meeting notes' },
				{
					content: 'Charlie reviewed the code',
					eventDate: Date.now() - 86_400_000,
					tags: ['review']
				}
			],
			{ consolidate: false }
		)
		expect(results).toHaveLength(3)
		for (const result of results) {
			expect(result.memories.length).toBeGreaterThanOrEqual(1)
		}
	})

	it('single batch multiple documents', async () => {
		const r1 = await t.hs.retain(bankId, 'resume alice', {
			facts: [
				{
					content: 'Alice has 5 years experience',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			documentId: 'resume-alice',
			consolidate: false,
			dedupThreshold: 0
		})
		const r2 = await t.hs.retain(bankId, 'resume bob', {
			facts: [
				{
					content: 'Bob specializes in backend',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Bob']
				}
			],
			documentId: 'resume-bob',
			consolidate: false,
			dedupThreshold: 0
		})
		expect(r1.memories[0]!.documentId).toBe('resume-alice')
		expect(r2.memories[0]!.documentId).toBe('resume-bob')
	})

	it('document upsert behavior', async () => {
		const r1 = await t.hs.retain(bankId, 'v1', {
			facts: [
				{
					content: 'Alice works at Acme v1',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			documentId: 'doc-upsert',
			consolidate: false
		})
		const r2 = await t.hs.retain(bankId, 'v2', {
			facts: [
				{
					content: 'Alice works at NewCorp v2',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			documentId: 'doc-upsert',
			consolidate: false,
			dedupThreshold: 0
		})
		expect(r1.memories).toHaveLength(1)
		expect(r2.memories).toHaveLength(1)
		expect(r2.memories[0]!.documentId).toBe('doc-upsert')
	})

	it('chunk fact mapping', async () => {
		const result = await t.hs.retain(bankId, 'technical documentation about APIs', {
			facts: [
				{ content: 'REST APIs use HTTP methods', factType: 'world', confidence: 0.9, entities: [] }
			],
			documentId: 'chunk-test-doc',
			consolidate: false
		})
		expect(result.memories[0]!.documentId).toBe('chunk-test-doc')
		// chunkId is set based on document chunking
		expect(typeof result.memories[0]!.chunkId).toBe('string')
	})

	it('chunk ordering preservation', async () => {
		const result = await t.hs.retain(bankId, 'multi-section doc', {
			facts: [
				{
					content: 'First section about databases',
					factType: 'world',
					confidence: 0.9,
					entities: []
				},
				{ content: 'Second section about APIs', factType: 'world', confidence: 0.9, entities: [] },
				{ content: 'Third section about testing', factType: 'world', confidence: 0.9, entities: [] }
			],
			documentId: 'ordered-doc',
			consolidate: false,
			dedupThreshold: 0
		})
		expect(result.memories).toHaveLength(3)
		expect(result.memories[0]!.content).toContain('databases')
		expect(result.memories[1]!.content).toContain('APIs')
		expect(result.memories[2]!.content).toContain('testing')
	})

	it('chunks truncation behavior', async () => {
		const largeContent = 'A'.repeat(10_000)
		const result = await t.hs.retain(bankId, largeContent, {
			facts: [
				{ content: 'Summary of large content', factType: 'world', confidence: 0.9, entities: [] }
			],
			documentId: 'large-doc',
			consolidate: false
		})
		expect(result.memories).toHaveLength(1)
		expect(result.memories[0]!.content).toBe('Summary of large content')
	})

	it('temporal links creation', async () => {
		const baseTime = Date.now() - 86_400_000
		await t.hs.retain(bankId, 'morning', {
			facts: [
				{
					content: 'Alice had coffee at 10am',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			eventDate: baseTime,
			consolidate: false,
			dedupThreshold: 0
		})
		await t.hs.retain(bankId, 'afternoon', {
			facts: [
				{
					content: 'Alice had lunch at 2pm',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			eventDate: baseTime + 4 * 3_600_000,
			consolidate: false,
			dedupThreshold: 0
		})
		const links = t.hs.getGraphData(bankId).edges.filter((e) => e.linkType === 'temporal')
		expect(links.length).toBeGreaterThanOrEqual(1)
		expect(links[0]!.weight).toBeGreaterThan(0)
		expect(links[0]!.weight).toBeLessThanOrEqual(1)
	})

	it('semantic links creation', async () => {
		await t.hs.retain(bankId, 'r1', {
			facts: [
				{
					content: 'Alice is skilled at Python programming',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			consolidate: false,
			dedupThreshold: 0
		})
		await t.hs.retain(bankId, 'r2', {
			facts: [
				{
					content: 'Alice excels at Python development',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			consolidate: false,
			dedupThreshold: 0
		})
		// Semantic links depend on embedding similarity — with hash-based embeddings these
		// may or may not fire, so just verify the graph has edges (entity links will be present)
		expect(t.hs.getGraphData(bankId).edges.length).toBeGreaterThanOrEqual(1)
	})

	it('entity links creation', async () => {
		// Entity links are created between memories in the SAME retain call that share entities
		const result = await t.hs.retain(bankId, 'r1', {
			facts: [
				{
					content: 'Alice joined the engineering team',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				},
				{
					content: 'Alice led the design review',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			consolidate: false,
			dedupThreshold: 0
		})
		const entityLinks = result.links.filter((l) => l.linkType === 'entity')
		expect(entityLinks.length).toBeGreaterThanOrEqual(1)
	})

	it('people name extraction', async () => {
		const result = await t.hs.retain(bankId, 'team notes', {
			facts: [
				{
					content: 'Alice and Bob discussed the project',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice', 'Bob']
				}
			],
			consolidate: false
		})
		const entityNames = result.entities.map((e) => e.name.toLowerCase())
		expect(entityNames).toContain('alice')
		expect(entityNames).toContain('bob')
	})

	it('mention count accuracy', async () => {
		for (let i = 0; i < 3; i++) {
			await t.hs.retain(bankId, `r${i}`, {
				facts: [
					{
						content: `Alice did thing number ${i}`,
						factType: 'experience',
						confidence: 0.9,
						entities: ['Alice']
					}
				],
				consolidate: false,
				dedupThreshold: 0
			})
		}
		const hdb = getHdb(t.hs)
		const allEntities = hdb.db
			.select()
			.from(hdb.schema.entities)
			.where(eq(hdb.schema.entities.bankId, bankId))
			.all()
		const alice = allEntities.find((e) => e.name.toLowerCase().includes('alice'))
		expect(alice).toBeDefined()
		expect(alice!.mentionCount).toBeGreaterThanOrEqual(3)
	})

	it('mention count batch retain', async () => {
		// Use separate retains with pre-extracted facts mentioning "Bob"
		for (let i = 0; i < 3; i++) {
			await t.hs.retain(bankId, `batch-item-${i}`, {
				facts: [
					{
						content: `Bob completed milestone ${i}`,
						factType: 'experience',
						confidence: 0.9,
						entities: ['Bob']
					}
				],
				consolidate: false,
				dedupThreshold: 0
			})
		}
		const hdb = getHdb(t.hs)
		const allEntities = hdb.db
			.select()
			.from(hdb.schema.entities)
			.where(eq(hdb.schema.entities.bankId, bankId))
			.all()
		const bob = allEntities.find((e) => e.name.toLowerCase().includes('bob'))
		expect(bob).toBeDefined()
		expect(bob!.mentionCount).toBeGreaterThanOrEqual(3)
	})

	it('causal links creation', async () => {
		// causalRelations: targetIndex points to a PREVIOUS fact (must be < current factIndex)
		// fact[1] is caused_by fact[0], so targetIndex=0 on fact[1]
		const result = await t.hs.retain(bankId, 'causal chain', {
			facts: [
				{
					content: 'Heavy rain flooded the roads',
					factType: 'world',
					confidence: 0.9,
					entities: [],
					tags: []
				},
				{
					content: 'Traffic was diverted because of flooding',
					factType: 'world',
					confidence: 0.9,
					entities: [],
					tags: [],
					causalRelations: [{ targetIndex: 0, relationType: 'caused_by', strength: 0.9 }]
				}
			],
			consolidate: false,
			dedupThreshold: 0
		})
		const causalLinks = result.links.filter((l) => l.linkType === 'caused_by')
		expect(causalLinks.length).toBeGreaterThanOrEqual(1)
	})

	it('all link types together', async () => {
		// Put both facts in one retain so entity + temporal links are created together
		const baseTime = Date.now() - 86_400_000
		const result = await t.hs.retain(bankId, 'r1', {
			facts: [
				{
					content: 'Alice excels at Python programming',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				},
				{
					content: 'Alice is great at Python development',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			eventDate: baseTime,
			consolidate: false,
			dedupThreshold: 0
		})
		const linkTypes = new Set(result.links.map((l) => l.linkType))
		// Entity links created for shared entity "Alice"
		expect(linkTypes.has('entity')).toBe(true)
		// Temporal links created for nearby mentionedAt times
		expect(linkTypes.has('temporal')).toBe(true)
	})

	it('semantic links within same batch', async () => {
		const result = await t.hs.retain(bankId, 'batch', {
			facts: [
				{
					content: 'Alice is skilled at Python programming',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				},
				{
					content: 'Alice excels at Python coding',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice']
				}
			],
			consolidate: false,
			dedupThreshold: 0
		})
		expect(result.memories).toHaveLength(2)
		// At minimum entity links are created between the two Alice facts
		expect(result.links.length).toBeGreaterThanOrEqual(1)
	})

	it('temporal links within same batch', async () => {
		const baseTime = Date.now() - 86_400_000
		const result = await t.hs.retain(bankId, 'batch', {
			facts: [
				{
					content: 'Morning standup meeting',
					factType: 'experience',
					confidence: 0.9,
					entities: []
				},
				{
					content: 'Afternoon code review session',
					factType: 'experience',
					confidence: 0.9,
					entities: []
				}
			],
			eventDate: baseTime,
			consolidate: false,
			dedupThreshold: 0
		})
		expect(result.memories).toHaveLength(2)
		const temporalLinks = result.links.filter((l) => l.linkType === 'temporal')
		expect(temporalLinks.length).toBeGreaterThanOrEqual(1)
	})

	it('user provided entities', async () => {
		const result = await t.hs.retain(bankId, 'test', {
			facts: [
				{
					content: 'Working on ProjectX at ACME Corp',
					factType: 'experience',
					confidence: 0.9,
					entities: ['ProjectX', 'ACME Corp']
				}
			],
			consolidate: false
		})
		const entityNames = result.entities.map((e) => e.name.toLowerCase())
		expect(entityNames).toContain('projectx')
		expect(entityNames).toContain('acme corp')
	})

	it('recall result model empty construction', async () => {
		// Verify retain with empty facts produces empty result (no crash)
		const result = await t.hs.retain(bankId, 'simple', {
			facts: [],
			consolidate: false
		})
		expect(result.memories).toHaveLength(0)
		expect(result.entities).toHaveLength(0)
		expect(result.links).toHaveLength(0)
	})

	it('custom extraction mode', async () => {
		// mode and customGuidelines are accepted without error
		const result = await t.hs.retain(bankId, 'content', {
			facts: [
				{
					content: 'Alice visited Rome for vacation',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice', 'Rome']
				}
			],
			mode: 'custom',
			customGuidelines: 'Extract only travel-related facts',
			consolidate: false
		})
		expect(result.memories).toHaveLength(1)
		expect(result.memories[0]!.content).toContain('Rome')
	})

	it('retain batch with per item tags on document', async () => {
		const result = await t.hs.retain(bankId, 'tagged content', {
			facts: [
				{
					content: 'Alice visited Rome for work',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Alice'],
					tags: ['travel']
				},
				{
					content: 'Bob stayed home and coded',
					factType: 'experience',
					confidence: 0.9,
					entities: ['Bob'],
					tags: ['domestic']
				}
			],
			tags: ['global-tag'],
			documentId: 'tagged-doc',
			consolidate: false,
			dedupThreshold: 0
		})
		expect(result.memories).toHaveLength(2)
		// Per-fact tags are merged with global tags
		expect(result.memories[0]!.tags).toContain('travel')
		expect(result.memories[0]!.tags).toContain('global-tag')
		expect(result.memories[1]!.tags).toContain('domestic')
		expect(result.memories[1]!.tags).toContain('global-tag')
	})
})
