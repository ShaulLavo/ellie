/**
 * Tests for mental model management — CRUD, refresh, auto-refresh.
 *
 * Port of test_mental_models.py + test_reflections.py (mental model parts).
 * Integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createTestHindsight, createTestBank, type TestHindsight } from './setup'

async function waitFor(
	condition: () => boolean,
	timeoutMs: number = 1500,
	intervalMs: number = 25
): Promise<void> {
	const startedAt = Date.now()
	while (Date.now() - startedAt <= timeoutMs) {
		if (condition()) return
		await new Promise((resolve) => setTimeout(resolve, intervalMs))
	}
	throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`)
}

describe('Mental models', () => {
	let t: TestHindsight
	let bankId: string

	beforeEach(() => {
		t = createTestHindsight()
		bankId = createTestBank(t.hs)
	})

	afterEach(() => {
		t.cleanup()
	})

	// ── Create ──────────────────────────────────────────────────────────────

	describe('createMentalModel', () => {
		it('creates a mental model with required fields', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Team Preferences',
				sourceQuery: "What are the team's communication preferences?"
			})

			expect(model.id).toBeDefined()
			expect(model.name).toBe('Team Preferences')
			expect(model.sourceQuery).toBe("What are the team's communication preferences?")
			expect(model.bankId).toBe(bankId)
		})

		it('creates with initial content', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Summary',
				sourceQuery: 'Team summary',
				content: 'The team prefers async communication via Slack'
			})

			expect(model.content).toBe('The team prefers async communication via Slack')
		})

		it('creates with tags', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Tagged Model',
				sourceQuery: 'query',
				tags: ['team', 'communication']
			})

			expect(model.tags).toEqual(['team', 'communication'])
		})

		it('creates with autoRefresh flag', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Auto Model',
				sourceQuery: 'query',
				autoRefresh: true
			})

			expect(model.autoRefresh).toBe(true)
		})

		it('defaults autoRefresh to false', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Default Model',
				sourceQuery: 'query'
			})

			expect(model.autoRefresh).toBe(false)
		})

		it('sets timestamps', async () => {
			const before = Date.now()
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Timed',
				sourceQuery: 'query'
			})
			const after = Date.now()

			expect(model.createdAt).toBeGreaterThanOrEqual(before)
			expect(model.createdAt).toBeLessThanOrEqual(after)
		})
	})

	// ── Get ─────────────────────────────────────────────────────────────────

	describe('getMentalModel', () => {
		it('retrieves a mental model by ID', async () => {
			const created = await t.hs.createMentalModel(bankId, {
				name: 'Findable',
				sourceQuery: 'query'
			})

			const found = t.hs.getMentalModel(bankId, created.id)
			expect(found).toBeDefined()
			expect(found!.id).toBe(created.id)
			expect(found!.name).toBe('Findable')
		})

		it('returns undefined for non-existent ID', () => {
			expect(t.hs.getMentalModel(bankId, 'nonexistent')).toBeUndefined()
		})

		it('returns undefined for wrong bank', async () => {
			const otherBank = createTestBank(t.hs, 'other-bank')
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Bank-scoped',
				sourceQuery: 'query'
			})

			expect(t.hs.getMentalModel(otherBank, model.id)).toBeUndefined()
		})
	})

	// ── List ────────────────────────────────────────────────────────────────

	describe('listMentalModels', () => {
		it('returns empty array when none exist', () => {
			expect(t.hs.listMentalModels(bankId)).toHaveLength(0)
		})

		it('returns all mental models for a bank', async () => {
			await t.hs.createMentalModel(bankId, { name: 'M1', sourceQuery: 'q1' })
			await t.hs.createMentalModel(bankId, { name: 'M2', sourceQuery: 'q2' })
			await t.hs.createMentalModel(bankId, { name: 'M3', sourceQuery: 'q3' })

			expect(t.hs.listMentalModels(bankId)).toHaveLength(3)
		})

		it('filters by tags when tags option provided', async () => {
			await t.hs.createMentalModel(bankId, {
				name: 'Tag 1 model',
				sourceQuery: 'q1',
				tags: ['tag1']
			})
			await t.hs.createMentalModel(bankId, {
				name: 'Tag 2 model',
				sourceQuery: 'q2',
				tags: ['tag2']
			})
			await t.hs.createMentalModel(bankId, {
				name: 'Untagged model',
				sourceQuery: 'q3'
			})

			const filteredTag1 = t.hs.listMentalModels(bankId, { tags: ['tag1'] })
			expect(filteredTag1).toHaveLength(1)
			expect(filteredTag1[0]!.name).toBe('Tag 1 model')

			const filteredTag2 = t.hs.listMentalModels(bankId, { tags: ['tag2'] })
			expect(filteredTag2).toHaveLength(1)
			expect(filteredTag2[0]!.name).toBe('Tag 2 model')
		})

		it('is bank-scoped', async () => {
			const otherBank = createTestBank(t.hs, 'other-bank')
			await t.hs.createMentalModel(bankId, { name: 'Bank1Model', sourceQuery: 'q' })
			await t.hs.createMentalModel(otherBank, { name: 'Bank2Model', sourceQuery: 'q' })

			expect(t.hs.listMentalModels(bankId)).toHaveLength(1)
			expect(t.hs.listMentalModels(otherBank)).toHaveLength(1)
		})
	})

	// ── Update ──────────────────────────────────────────────────────────────

	describe('updateMentalModel', () => {
		it('updates the name', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Old Name',
				sourceQuery: 'query'
			})

			const updated = await t.hs.updateMentalModel(bankId, model.id, {
				name: 'New Name'
			})

			expect(updated.name).toBe('New Name')
		})

		it('updates the content', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Model',
				sourceQuery: 'query',
				content: 'Old content'
			})

			const updated = await t.hs.updateMentalModel(bankId, model.id, {
				content: 'New content'
			})

			expect(updated.content).toBe('New content')
		})

		it('updates tags', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Model',
				sourceQuery: 'query',
				tags: ['old-tag']
			})

			const updated = await t.hs.updateMentalModel(bankId, model.id, {
				tags: ['new-tag-1', 'new-tag-2']
			})

			expect(updated.tags).toEqual(['new-tag-1', 'new-tag-2'])
		})

		it('updates autoRefresh', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Model',
				sourceQuery: 'query',
				autoRefresh: false
			})

			const updated = await t.hs.updateMentalModel(bankId, model.id, {
				autoRefresh: true
			})

			expect(updated.autoRefresh).toBe(true)
		})

		it('updates updatedAt timestamp', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Model',
				sourceQuery: 'query'
			})

			const updated = await t.hs.updateMentalModel(bankId, model.id, {
				name: 'Updated'
			})

			expect(updated.updatedAt).toBeGreaterThanOrEqual(model.createdAt)
		})
	})

	// ── Delete ──────────────────────────────────────────────────────────────

	describe('deleteMentalModel', () => {
		it('deletes a mental model', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'ToDelete',
				sourceQuery: 'query'
			})

			t.hs.deleteMentalModel(bankId, model.id)
			expect(t.hs.getMentalModel(bankId, model.id)).toBeUndefined()
		})

		it('does not affect other models', async () => {
			const keep = await t.hs.createMentalModel(bankId, {
				name: 'Keep',
				sourceQuery: 'q1'
			})
			const remove = await t.hs.createMentalModel(bankId, {
				name: 'Remove',
				sourceQuery: 'q2'
			})

			t.hs.deleteMentalModel(bankId, remove.id)

			expect(t.hs.getMentalModel(bankId, keep.id)).toBeDefined()
			expect(t.hs.getMentalModel(bankId, remove.id)).toBeUndefined()
		})
	})

	// ── Refresh (TDD — calls reflect which needs agentic mock) ────────────

	describe('refreshMentalModel', () => {
		it('refreshes content via reflect() and updates model content', async () => {
			// Create a model with initial placeholder content
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Refreshable',
				sourceQuery: 'What does the team prefer?',
				content: 'Initial placeholder'
			})

			// The mock adapter returns text via chatStream; reflect() will produce
			// an answer from whatever the mock returns. Set a recognizable answer.
			t.adapter.setResponse('The team prefers async communication and daily standups.')

			const result = await t.hs.refreshMentalModel(bankId, model.id)

			// Content should be updated to the reflect answer
			expect(result.model.content).toBe('The team prefers async communication and daily standups.')
			expect(result.reflectResult).toBeDefined()
			expect(result.reflectResult.answer).toBe(
				'The team prefers async communication and daily standups.'
			)

			// Verify persistence
			const fetched = t.hs.getMentalModel(bankId, model.id)
			expect(fetched!.content).toBe('The team prefers async communication and daily standups.')
		})

		it('updates lastRefreshedAt timestamp after refresh', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Timed Refresh',
				sourceQuery: 'query',
				content: 'old content'
			})

			const beforeRefresh = Date.now()

			t.adapter.setResponse('Refreshed content')
			const result = await t.hs.refreshMentalModel(bankId, model.id)

			const afterRefresh = Date.now()

			expect(result.model.lastRefreshedAt).toBeDefined()
			expect(result.model.lastRefreshedAt).not.toBeNull()
			expect(result.model.lastRefreshedAt!).toBeGreaterThanOrEqual(beforeRefresh)
			expect(result.model.lastRefreshedAt!).toBeLessThanOrEqual(afterRefresh)

			// Verify persistence via getMentalModel
			const fetched = t.hs.getMentalModel(bankId, model.id)
			expect(fetched!.lastRefreshedAt).toBe(result.model.lastRefreshedAt)
		})

		it.todo(
			'refresh with tags only accesses tagged memories (requires real-LLM tool-calling loop parity)'
		)

		it('refresh with directives applies them to reflect prompt', async () => {
			t.hs.createDirective(bankId, {
				name: 'Response Style',
				content: 'Always be concise and professional'
			})
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Directive Refresh Model',
				sourceQuery: 'Summarize the team'
			})

			t.adapter.setResponse('Concise professional answer.')
			await t.hs.refreshMentalModel(bankId, model.id)

			const lastCall = t.adapter.calls[t.adapter.calls.length - 1]
			const callText = JSON.stringify(lastCall)
			expect(callText).toContain('## DIRECTIVES (MANDATORY)')
			expect(callText).toContain('Response Style')
			expect(callText).toContain('Always be concise and professional')
		})

		it('refresh completes without error when bank has directives', async () => {
			// Create a directive in the bank
			t.hs.createDirective(bankId, {
				name: 'Be precise',
				content: 'Always provide precise information with sources.'
			})

			// Create a mental model
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Directive Model',
				sourceQuery: 'What are the key facts?',
				content: 'Placeholder'
			})

			// Set a mock response for the reflect call
			t.adapter.setResponse('Precise refreshed content with sources.')

			// Should complete without error — directives are loaded and injected
			const result = await t.hs.refreshMentalModel(bankId, model.id)

			expect(result.model.content).toBe('Precise refreshed content with sources.')
			expect(result.reflectResult.answer).toBeDefined()
		})

		it('refresh updates content from initial placeholder value', async () => {
			// Create model with no initial content (content is null)
			const model = await t.hs.createMentalModel(bankId, {
				name: 'No Content Model',
				sourceQuery: 'What do we know about the project?'
			})

			expect(model.content).toBeNull()
			expect(model.lastRefreshedAt).toBeNull()

			t.adapter.setResponse('The project uses TypeScript and Bun runtime.')

			const result = await t.hs.refreshMentalModel(bankId, model.id)

			// Content should now be set
			expect(result.model.content).toBe('The project uses TypeScript and Bun runtime.')
			expect(result.model.lastRefreshedAt).not.toBeNull()
		})
	})

	// ── Mental models in reflect ──────────────────────────────────────────

	describe('mental models used in reflect', () => {
		it('reflect searches mental models when they exist', async () => {
			await t.hs.createMentalModel(bankId, {
				name: 'Team Collaboration Practices',
				sourceQuery: 'How does the team collaborate?',
				content: 'The team uses async communication via Slack and holds daily standups at 9am.',
				tags: ['team']
			})

			t.adapter.setResponse('Team collaboration answer.')
			await t.hs.reflect(bankId, 'How does the team work together?')

			const lastCall = t.adapter.calls[t.adapter.calls.length - 1]
			const callText = JSON.stringify(lastCall)
			expect(callText).toContain('search_mental_models')
		})

		it('stale mental model triggers tier 2/3 search', async () => {
			await t.hs.createMentalModel(bankId, {
				name: 'Potentially stale model',
				sourceQuery: 'What is the current status?',
				content: 'Old summary'
			})

			t.adapter.setResponse('Drill-down answer.')
			await t.hs.reflect(bankId, 'What is the latest status?')

			const lastCall = t.adapter.calls[t.adapter.calls.length - 1]
			const callText = JSON.stringify(lastCall)
			expect(callText).toContain('search_observations')
			expect(callText).toContain('"recall"')
			expect(callText).toContain('search_memories')
		})

		it('mental model with autoRefresh gets refreshed after consolidation', async () => {
			const model = await t.hs.createMentalModel(bankId, {
				name: 'Auto Refresh Model',
				sourceQuery: 'What happened recently?',
				content: 'Initial content',
				autoRefresh: true
			})

			await t.hs.retain(bankId, 'retain source', {
				facts: [{ content: 'Alice shipped a new feature.' }],
				consolidate: false
			})

			t.adapter.setResponses([
				JSON.stringify([
					{ action: 'create', text: 'Alice shipped a new feature.', reason: 'new update' }
				]),
				'Refreshed auto model content.'
			])

			const result = await t.hs.consolidate(bankId)
			expect(result.mentalModelsRefreshQueued).toBeGreaterThanOrEqual(1)

			await waitFor(() => {
				const after = t.hs.getMentalModel(bankId, model.id)
				return after?.lastRefreshedAt !== null && after?.content !== 'Initial content'
			})
		})

		it('consolidation only refreshes matching tagged models', async () => {
			const mmAlice = await t.hs.createMentalModel(bankId, {
				name: 'Alice model',
				sourceQuery: 'What about Alice?',
				content: 'Initial Alice content',
				tags: ['user:alice'],
				autoRefresh: true
			})
			const mmBob = await t.hs.createMentalModel(bankId, {
				name: 'Bob model',
				sourceQuery: 'What about Bob?',
				content: 'Initial Bob content',
				tags: ['user:bob'],
				autoRefresh: true
			})
			const mmUntagged = await t.hs.createMentalModel(bankId, {
				name: 'Global model',
				sourceQuery: 'What about everyone?',
				content: 'Initial global content',
				autoRefresh: true
			})
			const aliceInitial = mmAlice.lastRefreshedAt
			const bobInitial = mmBob.lastRefreshedAt
			const globalInitial = mmUntagged.lastRefreshedAt

			await t.hs.retain(bankId, 'retain source', {
				facts: [{ content: 'Alice likes React', tags: ['user:alice'] }],
				consolidate: false
			})

			t.adapter.setResponses([
				JSON.stringify([
					{ action: 'create', text: 'Alice likes React', reason: 'new observation' }
				]),
				'Alice model refreshed',
				'Global model refreshed'
			])

			const result = await t.hs.consolidate(bankId)
			expect(result.mentalModelsRefreshQueued).toBe(2)

			await waitFor(() => {
				const a = t.hs.getMentalModel(bankId, mmAlice.id)
				const b = t.hs.getMentalModel(bankId, mmBob.id)
				const g = t.hs.getMentalModel(bankId, mmUntagged.id)
				return (
					(a?.lastRefreshedAt ?? null) !== aliceInitial &&
					(g?.lastRefreshedAt ?? null) !== globalInitial &&
					(b?.lastRefreshedAt ?? null) === bobInitial
				)
			})
		})

		it('untagged auto-refresh models are always refreshed after any consolidation', async () => {
			const tagged = await t.hs.createMentalModel(bankId, {
				name: 'Tagged model',
				sourceQuery: 'tagged query',
				content: 'Initial tagged content',
				tags: ['project-x'],
				autoRefresh: true
			})
			const untagged = await t.hs.createMentalModel(bankId, {
				name: 'Untagged model',
				sourceQuery: 'untagged query',
				content: 'Initial untagged content',
				autoRefresh: true
			})
			const taggedInitial = tagged.lastRefreshedAt
			const untaggedInitial = untagged.lastRefreshedAt

			await t.hs.retain(bankId, 'retain source', {
				facts: [{ content: 'Project X note', tags: ['project-x'] }],
				consolidate: false
			})

			t.adapter.setResponses([
				JSON.stringify([{ action: 'create', text: 'Project X note', reason: 'new note' }]),
				'Tagged refresh',
				'Untagged refresh'
			])

			const result = await t.hs.consolidate(bankId)
			expect(result.mentalModelsRefreshQueued).toBe(2)

			await waitFor(() => {
				const tModel = t.hs.getMentalModel(bankId, tagged.id)
				const uModel = t.hs.getMentalModel(bankId, untagged.id)
				return (
					(tModel?.lastRefreshedAt ?? null) !== taggedInitial &&
					(uModel?.lastRefreshedAt ?? null) !== untaggedInitial
				)
			})
		})

		it.todo(
			'reflect based_on separates directives, memories, and mental models (requires based_on API parity + real-LLM tool-calling)'
		)
	})

	// ── Tag security boundaries ───────────────────────────────────────────

	describe('tag security', () => {
		it.todo('mental model refresh respects tag boundaries (requires real-LLM tool-calling)')

		it.todo('refresh with tags only accesses same tagged models (requires real-LLM tool-calling)')

		it.todo(
			'refresh of tagged model does not access different-tagged models (requires real-LLM tool-calling)'
		)

		it.todo('refresh of tagged model excludes untagged memories (requires real-LLM tool-calling)')

		it('consolidation does not refresh models with non-matching tags', async () => {
			const mmAlice = await t.hs.createMentalModel(bankId, {
				name: 'Alice only',
				sourceQuery: 'Alice summary',
				tags: ['user:alice'],
				autoRefresh: true
			})
			const mmBob = await t.hs.createMentalModel(bankId, {
				name: 'Bob only',
				sourceQuery: 'Bob summary',
				tags: ['user:bob'],
				autoRefresh: true
			})

			await t.hs.retain(bankId, 'retain source', {
				facts: [{ content: 'Alice likes coffee', tags: ['user:alice'] }],
				consolidate: false
			})

			t.adapter.setResponses([
				JSON.stringify([{ action: 'create', text: 'Alice likes coffee', reason: 'new fact' }]),
				'Alice refresh response'
			])

			const result = await t.hs.consolidate(bankId)
			expect(result.mentalModelsRefreshQueued).toBe(1)

			await waitFor(() => {
				const aliceAfter = t.hs.getMentalModel(bankId, mmAlice.id)
				const bobAfter = t.hs.getMentalModel(bankId, mmBob.id)
				return aliceAfter?.lastRefreshedAt !== null && bobAfter?.lastRefreshedAt === null
			})
		})
	})

	// ── Custom ID (port of test_reflections.py) ──────────────────────────

	describe('custom ID', () => {
		it('creates mental model with custom ID', async () => {
			const customId = 'team-communication-preferences'
			const model = await t.hs.createMentalModel(bankId, {
				id: customId,
				name: 'Team Communication Preferences',
				sourceQuery: 'How does the team prefer to communicate?',
				content: 'The team prefers async communication via Slack',
				tags: ['team', 'communication']
			})

			expect(model.id).toBe(customId)

			const fetched = t.hs.getMentalModel(bankId, customId)
			expect(fetched).toBeDefined()
			expect(fetched!.id).toBe(customId)
			expect(fetched!.name).toBe('Team Communication Preferences')
		})
	})
})
