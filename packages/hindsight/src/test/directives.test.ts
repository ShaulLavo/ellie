/**
 * Tests for directive management — CRUD, priority, tags, injection.
 *
 * Port of test_reflections.py (directive parts) + test_mental_models.py (directive parts).
 * Integration tests.
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
	createRealTestHindsight,
	createTestBank,
	describeWithLLM,
	type TestHindsight,
	type RealTestHindsight
} from './setup'
import { loadDirectivesForReflect } from '../directives'
import type { HindsightDatabase } from '../db'

describe('Directives', () => {
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

	describe('createDirective', () => {
		it('creates a directive with required fields', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'Be Concise',
				content: 'Keep all responses under 3 sentences.'
			})

			expect(directive.id).toBeDefined()
			expect(directive.bankId).toBe(bankId)
			expect(directive.name).toBe('Be Concise')
			expect(directive.content).toBe(
				'Keep all responses under 3 sentences.'
			)
		})

		it('defaults priority to 0', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'Default Priority',
				content: 'Test'
			})
			expect(directive.priority).toBe(0)
		})

		it('defaults isActive to true', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'Active Default',
				content: 'Test'
			})
			expect(directive.isActive).toBe(true)
		})

		it('creates with custom priority', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'High Priority',
				content: 'Very important rule',
				priority: 10
			})
			expect(directive.priority).toBe(10)
		})

		it('creates as inactive', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'Inactive',
				content: 'Paused rule',
				isActive: false
			})
			expect(directive.isActive).toBe(false)
		})

		it('creates with tags', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'Tagged',
				content: 'Rule for team-a',
				tags: ['team-a']
			})
			expect(directive.tags).toEqual(['team-a'])
		})

		it('defaults tags to null', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'Untagged',
				content: 'Global rule'
			})
			expect(directive.tags).toBeNull()
		})
	})

	// ── Get ─────────────────────────────────────────────────────────────────

	describe('getDirective', () => {
		it('retrieves a directive by ID', () => {
			const created = t.hs.createDirective(bankId, {
				name: 'Findable',
				content: 'Test'
			})

			const found = t.hs.getDirective(bankId, created.id)
			expect(found).toBeDefined()
			expect(found!.id).toBe(created.id)
			expect(found!.name).toBe('Findable')
		})

		it('returns undefined for non-existent ID', () => {
			expect(
				t.hs.getDirective(bankId, 'nonexistent')
			).toBeUndefined()
		})
	})

	// ── List ────────────────────────────────────────────────────────────────

	describe('listDirectives', () => {
		it('returns empty array when none exist', () => {
			expect(t.hs.listDirectives(bankId)).toHaveLength(0)
		})

		it('returns only active directives by default', () => {
			t.hs.createDirective(bankId, {
				name: 'Active',
				content: 'active'
			})
			t.hs.createDirective(bankId, {
				name: 'Inactive',
				content: 'inactive',
				isActive: false
			})

			const active = t.hs.listDirectives(bankId)
			expect(active).toHaveLength(1)
			expect(active[0]!.name).toBe('Active')
		})

		it('returns all directives when activeOnly=false', () => {
			t.hs.createDirective(bankId, {
				name: 'Active',
				content: 'active'
			})
			t.hs.createDirective(bankId, {
				name: 'Inactive',
				content: 'inactive',
				isActive: false
			})

			const all = t.hs.listDirectives(bankId, false)
			expect(all).toHaveLength(2)
		})

		it('sorts by priority descending', () => {
			t.hs.createDirective(bankId, {
				name: 'Low',
				content: 'low',
				priority: 1
			})
			t.hs.createDirective(bankId, {
				name: 'High',
				content: 'high',
				priority: 10
			})
			t.hs.createDirective(bankId, {
				name: 'Mid',
				content: 'mid',
				priority: 5
			})

			const directives = t.hs.listDirectives(bankId)
			expect(directives[0]!.name).toBe('High')
			expect(directives[1]!.name).toBe('Mid')
			expect(directives[2]!.name).toBe('Low')
		})
	})

	// ── Update ──────────────────────────────────────────────────────────────

	describe('updateDirective', () => {
		it('updates the name', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'Old',
				content: 'test'
			})

			const updated = t.hs.updateDirective(
				bankId,
				directive.id,
				{
					name: 'New'
				}
			)
			expect(updated.name).toBe('New')
		})

		it('updates the content', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'Rule',
				content: 'Old content'
			})

			const updated = t.hs.updateDirective(
				bankId,
				directive.id,
				{
					content: 'New content'
				}
			)
			expect(updated.content).toBe('New content')
		})

		it('updates priority', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'Rule',
				content: 'test',
				priority: 0
			})

			const updated = t.hs.updateDirective(
				bankId,
				directive.id,
				{
					priority: 100
				}
			)
			expect(updated.priority).toBe(100)
		})

		it('updates isActive', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'Rule',
				content: 'test'
			})

			const updated = t.hs.updateDirective(
				bankId,
				directive.id,
				{
					isActive: false
				}
			)
			expect(updated.isActive).toBe(false)
		})

		it('updates tags', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'Rule',
				content: 'test'
			})

			const updated = t.hs.updateDirective(
				bankId,
				directive.id,
				{
					tags: ['new-tag']
				}
			)
			expect(updated.tags).toEqual(['new-tag'])
		})
	})

	// ── Delete ──────────────────────────────────────────────────────────────

	describe('deleteDirective', () => {
		it('deletes a directive', () => {
			const directive = t.hs.createDirective(bankId, {
				name: 'ToDelete',
				content: 'test'
			})

			t.hs.deleteDirective(bankId, directive.id)
			expect(
				t.hs.getDirective(bankId, directive.id)
			).toBeUndefined()
		})
	})

	// ── Tag-based loading for reflect ────────────────────────────────────

	describe('loadDirectivesForReflect', () => {
		it('returns only tagless directives when no session tags', () => {
			const hdb = (
				t.hs as unknown as { hdb: HindsightDatabase }
			).hdb

			t.hs.createDirective(bankId, {
				name: 'Global',
				content: 'global rule'
			})
			t.hs.createDirective(bankId, {
				name: 'Tagged',
				content: 'scoped rule',
				tags: ['team-a']
			})

			const result = loadDirectivesForReflect(hdb, bankId)
			expect(result).toHaveLength(1)
			expect(result[0]!.name).toBe('Global')
		})

		it('returns matching directives when session tags provided', () => {
			const hdb = (
				t.hs as unknown as { hdb: HindsightDatabase }
			).hdb

			t.hs.createDirective(bankId, {
				name: 'Team A Rule',
				content: 'for team a',
				tags: ['team-a']
			})
			t.hs.createDirective(bankId, {
				name: 'Team B Rule',
				content: 'for team b',
				tags: ['team-b']
			})

			const result = loadDirectivesForReflect(hdb, bankId, [
				'team-a'
			])
			expect(result).toHaveLength(1)
			expect(result[0]!.name).toBe('Team A Rule')
		})

		it('excludes tag-scoped directives from tagless session', () => {
			const hdb = (
				t.hs as unknown as { hdb: HindsightDatabase }
			).hdb

			t.hs.createDirective(bankId, {
				name: 'Global',
				content: 'global'
			})
			t.hs.createDirective(bankId, {
				name: 'Scoped',
				content: 'scoped',
				tags: ['private']
			})

			const result = loadDirectivesForReflect(hdb, bankId)
			expect(result).toHaveLength(1)
			expect(result[0]!.name).toBe('Global')
		})

		it('excludes tagless directives from tagged session (any mode)', () => {
			const hdb = (
				t.hs as unknown as { hdb: HindsightDatabase }
			).hdb

			t.hs.createDirective(bankId, {
				name: 'Global',
				content: 'global'
			})
			t.hs.createDirective(bankId, {
				name: 'Scoped',
				content: 'scoped',
				tags: ['team-a']
			})

			// loadDirectivesForReflect excludes tagless directives from tagged sessions
			// to enforce tag isolation. This is the intended behavior per the implementation.
			const result = loadDirectivesForReflect(hdb, bankId, [
				'team-a'
			])
			// Only the tag-matching directive should be returned
			expect(result).toHaveLength(1)
			expect(result[0]!.name).toBe('Scoped')
		})
	})

	// ── Directives in reflect (TDD — need agentic mock to verify prompt content) ─

	describe('directives in reflect', () => {
		it('reflect includes active directives in system prompt (verified via adapter call)', async () => {
			t.hs.createDirective(bankId, {
				name: 'Active Rule',
				content: 'Always begin with Hello.'
			})

			t.adapter.setResponse('Hello. Mock response.')
			await t.hs.reflect(bankId, 'What is the summary?', {
				saveObservations: false
			})

			const lastCall =
				t.adapter.calls[t.adapter.calls.length - 1]
			const optionsText = JSON.stringify(
				lastCall?.options ?? {}
			)
			expect(optionsText).toContain('DIRECTIVES')
			expect(optionsText).toContain(
				'Always begin with Hello.'
			)
		})

		it('inactive directives are excluded from reflect system prompt', async () => {
			t.hs.createDirective(bankId, {
				name: 'Inactive Rule',
				content: 'This should not appear in prompt.',
				isActive: false
			})
			t.hs.createDirective(bankId, {
				name: 'Active Rule',
				content: 'This should appear in prompt.'
			})

			t.adapter.setResponse('Hello. Mock response.')
			await t.hs.reflect(bankId, 'What is the summary?', {
				saveObservations: false
			})

			const lastCall =
				t.adapter.calls[t.adapter.calls.length - 1]
			const optionsText = JSON.stringify(
				lastCall?.options ?? {}
			)
			expect(optionsText).toContain(
				'This should appear in prompt.'
			)
			expect(optionsText).not.toContain(
				'This should not appear in prompt.'
			)
		})

		it('reflect follows language directive (e.g., respond in Spanish)', async () => {
			t.hs.createDirective(bankId, {
				name: 'Language Policy',
				content: 'ALWAYS respond in Spanish.'
			})

			t.adapter.setResponse('Respuesta en español.')
			const result = await t.hs.reflect(
				bankId,
				'What does Alice do for work?',
				{
					saveObservations: false
				}
			)

			const optionsText = JSON.stringify(
				t.adapter.calls[t.adapter.calls.length - 1]
					?.options ?? {}
			)
			expect(optionsText).toContain(
				'ALWAYS respond in Spanish'
			)
			expect(result.answer.toLowerCase()).toContain(
				'español'
			)
		})

		it('tagged directive not applied when session has no matching tags', async () => {
			t.hs.createDirective(bankId, {
				name: 'General Policy',
				content:
					'Always be polite and start responses with Hello.'
			})
			t.hs.createDirective(bankId, {
				name: 'Tagged Policy',
				content:
					'ALWAYS RESPOND IN ALL CAPS. PROJECT-X ONLY.',
				tags: ['project-x']
			})

			t.adapter.setResponse('Hello. Mock response.')
			await t.hs.reflect(bankId, 'What color is the sky?', {
				saveObservations: false
			})

			const optionsText = JSON.stringify(
				t.adapter.calls[t.adapter.calls.length - 1]
					?.options ?? {}
			)
			expect(optionsText).toContain(
				'Always be polite and start responses with Hello.'
			)
			expect(optionsText).not.toContain('PROJECT-X ONLY')
		})
	})
})

describeWithLLM('Directives with real LLM', () => {
	let t: RealTestHindsight
	let bankId: string

	beforeEach(async () => {
		t = await createRealTestHindsight()
		bankId = createTestBank(t.hs)
	})

	afterEach(() => {
		t.cleanup()
	})

	it('reflect follows format directive with real LLM', async () => {
		await t.hs.retain(bankId, 'facts', {
			facts: [
				{
					content: 'Alice is a software engineer at Google.'
				},
				{ content: 'Alice enjoys hiking on weekends.' }
			],
			consolidate: false,
			dedupThreshold: 0
		})

		t.hs.createDirective(bankId, {
			name: 'Response Format',
			content:
				"You MUST include the word 'CONFIRMED' somewhere in every response you give."
		})

		// Retry up to 3 times — LLMs may not always follow directives on first attempt
		let passed = false
		for (
			let attempt = 0;
			attempt < 3 && !passed;
			attempt++
		) {
			const result = await t.hs.reflect(
				bankId,
				'What does Alice do for work?',
				{
					saveObservations: false,
					budget: 'high'
				}
			)
			if (
				result.answer.toUpperCase().includes('CONFIRMED')
			) {
				passed = true
			}
		}
		expect(passed).toBe(true)
	}, 120_000)

	it.todo(
		'reflect follows language directive with real LLM (non-English responses)'
	)
})
