/**
 * Phase 4: Visual Semantics — Integration Tests
 *
 * Covers:
 * 1. Visual retain → visual recall end-to-end
 * 2. Mixed recall with includeVisual=true and cap enforcement
 * 3. includeVisual=false path equals non-visual baseline behavior
 * 4. Scope isolation with visual traces across projects/profiles
 * 5. Existing lifecycle tests remain green (retain → recall when visual disabled)
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

describe('Phase 4: Visual Integration', () => {
	let t: TestHindsight
	let bankId: string

	beforeEach(() => {
		t = createTestHindsight()
		bankId = createTestBank(t.hs)
	})

	afterEach(() => {
		t.cleanup()
	})

	// ── E2E: Visual retain → visual recall ─────────────────────────────

	describe('end-to-end visual retain → recall', () => {
		it('retains visual description and finds it via recall', async () => {
			// Retain some text memories as baseline
			await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content: 'The dashboard shows CPU metrics'
					}
				],
				consolidate: false
			})

			// Retain a visual description
			const visual = await t.hs.retainVisual({
				bankId,
				description:
					'Dashboard screenshot showing CPU utilization at 95%'
			})

			// Recall with visual enabled
			const result = await t.hs.recall(
				bankId,
				'CPU dashboard metrics',
				{
					limit: 10,
					includeVisual: true
				}
			)

			// Text memories should be present
			expect(result.memories.length).toBeGreaterThan(0)

			// Visual find should work independently
			const found = await t.hs.visualFind(
				bankId,
				'CPU dashboard',
				5
			)
			expect(found.length).toBeGreaterThan(0)
			expect(found[0]!.id).toBe(visual.id)
		})
	})

	// ── Mixed recall with cap enforcement ─────────────────────────────

	describe('mixed recall with cap enforcement', () => {
		it('enforces 20% visual cap in mixed results', async () => {
			// Retain 20 text memories
			await t.hs.retain(bankId, 'test', {
				facts: Array.from({ length: 20 }, (_, i) => ({
					content: `Fact ${i}: system monitoring detail ${i}`
				})),
				consolidate: false
			})

			// Retain 10 visual memories
			for (let i = 0; i < 10; i++) {
				await t.hs.retainVisual({
					bankId,
					description: `Monitoring screenshot ${i} showing system metric`
				})
			}

			// Recall with limit=20
			const result = await t.hs.recall(
				bankId,
				'system monitoring',
				{
					limit: 20,
					includeVisual: true
				}
			)

			const visualCount = result.visualMemories?.length ?? 0
			// 20% of 20 = 4 max
			expect(visualCount).toBeLessThanOrEqual(4)
		})
	})

	// ── Non-visual baseline behavior ──────────────────────────────────

	describe('non-visual baseline', () => {
		it('includeVisual=false produces identical results to pre-visual behavior', async () => {
			await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content: 'The API returns JSON responses'
					},
					{
						content: 'Users authenticate via OAuth2'
					}
				],
				consolidate: false
			})

			// Add a visual memory that should NOT appear
			await t.hs.retainVisual({
				bankId,
				description: 'API documentation screenshot'
			})

			// Recall without visual
			const withoutVisual = await t.hs.recall(
				bankId,
				'API authentication',
				{
					limit: 10,
					includeVisual: false
				}
			)

			// Recall with default (no includeVisual)
			const defaultRecall = await t.hs.recall(
				bankId,
				'API authentication',
				{ limit: 10 }
			)

			// Both should have no visual results
			expect(withoutVisual.visualMemories).toBeUndefined()
			expect(defaultRecall.visualMemories).toBeUndefined()

			// Both should have same text memories
			expect(withoutVisual.memories.length).toBe(
				defaultRecall.memories.length
			)
			expect(
				withoutVisual.memories.map(m => m.memory.id)
			).toEqual(
				defaultRecall.memories.map(m => m.memory.id)
			)
		})

		it('retain → recall baseline works when visual is disabled', async () => {
			await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content:
							'Peter enjoys mountain hiking on weekends'
					}
				],
				consolidate: false
			})

			const result = await t.hs.recall(
				bankId,
				'outdoor activities',
				{ limit: 5 }
			)

			expect(result.memories.length).toBeGreaterThan(0)
			expect(result.visualMemories).toBeUndefined()
		})
	})

	// ── Scope isolation ───────────────────────────────────────────────

	describe('scope isolation', () => {
		it('visual memories in different banks are isolated', async () => {
			const bankId2 = createTestBank(t.hs, 'bank-2')

			await t.hs.retainVisual({
				bankId,
				description: 'Visual memory in bank 1'
			})

			await t.hs.retainVisual({
				bankId: bankId2,
				description: 'Visual memory in bank 2'
			})

			const stats1 = t.hs.visualStats(bankId)
			const stats2 = t.hs.visualStats(bankId2)

			expect(stats1.totalVisualMemories).toBe(1)
			expect(stats2.totalVisualMemories).toBe(1)

			// Find should not cross banks
			const found1 = await t.hs.visualFind(
				bankId,
				'visual memory',
				10
			)
			const found2 = await t.hs.visualFind(
				bankId2,
				'visual memory',
				10
			)

			for (const hit of found1) {
				expect(
					found2.find(h => h.id === hit.id)
				).toBeUndefined()
			}
		})

		it('visual memories with scope tags are stored correctly', async () => {
			await t.hs.retainVisual({
				bankId,
				description: 'Project A screenshot',
				scope: {
					profile: 'user1',
					project: 'project-a'
				}
			})

			await t.hs.retainVisual({
				bankId,
				description: 'Project B screenshot',
				scope: {
					profile: 'user1',
					project: 'project-b'
				}
			})

			const stats = t.hs.visualStats(bankId)
			expect(stats.totalVisualMemories).toBe(2)
		})
	})

	// ── Recall trace includes visual phase ────────────────────────────

	describe('recall trace', () => {
		it('includes visual_fusion phase in trace when enabled', async () => {
			await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Some fact' }],
				consolidate: false
			})

			await t.hs.retainVisual({
				bankId,
				description: 'Some visual'
			})

			const result = await t.hs.recall(
				bankId,
				'test query',
				{
					limit: 10,
					includeVisual: true,
					enableTrace: true
				}
			)

			expect(result.trace).toBeDefined()
			const visualPhase = result.trace!.phaseMetrics.find(
				p => p.phaseName === 'visual_fusion'
			)
			expect(visualPhase).toBeDefined()
			expect(
				visualPhase!.details?.visualLimit
			).toBeDefined()
			expect(
				visualPhase!.details?.visualMaxShare
			).toBeDefined()
		})

		it('does not include visual_fusion phase when disabled', async () => {
			await t.hs.retain(bankId, 'test', {
				facts: [{ content: 'Some fact' }],
				consolidate: false
			})

			const result = await t.hs.recall(
				bankId,
				'test query',
				{
					limit: 10,
					enableTrace: true
				}
			)

			expect(result.trace).toBeDefined()
			const visualPhase = result.trace!.phaseMetrics.find(
				p => p.phaseName === 'visual_fusion'
			)
			expect(visualPhase).toBeUndefined()
		})
	})
})
