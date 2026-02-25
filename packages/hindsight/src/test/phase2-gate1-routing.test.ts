/**
 * Phase 2 Verification — Gate 1: Routing Decision Correctness
 *
 * Deterministic fixture tests at threshold edges:
 * - score 0.92, no conflict => reinforce
 * - score 0.9199, no conflict => reconsolidate
 * - score 0.78, no conflict => reconsolidate
 * - score < 0.78, no conflict => new_trace
 * - any score with conflict => reconsolidate
 */

import { describe, it, expect } from 'bun:test'
import {
	classifyRoute,
	REINFORCE_THRESHOLD,
	RECONSOLIDATE_THRESHOLD
} from '../routing'
import type { ReconRoute } from '../types'

describe('Gate 1: Routing Decision Correctness', () => {
	// ── Threshold constants verification ────────────────────────────────────

	it('REINFORCE_THRESHOLD is exactly 0.92', () => {
		expect(REINFORCE_THRESHOLD).toBe(0.92)
	})

	it('RECONSOLIDATE_THRESHOLD is exactly 0.78', () => {
		expect(RECONSOLIDATE_THRESHOLD).toBe(0.78)
	})

	// ── Edge-case routing at exact threshold boundaries ─────────────────────

	describe('exact threshold edge cases', () => {
		it('score 0.92, no conflict => reinforce', () => {
			expect(classifyRoute(0.92, false)).toBe('reinforce')
		})

		it('score 0.9199, no conflict => reconsolidate', () => {
			expect(classifyRoute(0.9199, false)).toBe(
				'reconsolidate'
			)
		})

		it('score 0.78, no conflict => reconsolidate', () => {
			expect(classifyRoute(0.78, false)).toBe(
				'reconsolidate'
			)
		})

		it('score < 0.78 (0.7799), no conflict => new_trace', () => {
			expect(classifyRoute(0.7799, false)).toBe('new_trace')
		})

		it('score < 0.78 (0.5), no conflict => new_trace', () => {
			expect(classifyRoute(0.5, false)).toBe('new_trace')
		})

		it('score < 0.78 (0.0), no conflict => new_trace', () => {
			expect(classifyRoute(0.0, false)).toBe('new_trace')
		})
	})

	// ── Conflict override — any score with conflict => reconsolidate ────────

	describe('conflict overrides to reconsolidate regardless of score', () => {
		it('score 1.0 with conflict => reconsolidate', () => {
			expect(classifyRoute(1.0, true)).toBe('reconsolidate')
		})

		it('score 0.92 with conflict => reconsolidate', () => {
			expect(classifyRoute(0.92, true)).toBe(
				'reconsolidate'
			)
		})

		it('score 0.9199 with conflict => reconsolidate', () => {
			expect(classifyRoute(0.9199, true)).toBe(
				'reconsolidate'
			)
		})

		it('score 0.78 with conflict => reconsolidate', () => {
			expect(classifyRoute(0.78, true)).toBe(
				'reconsolidate'
			)
		})

		it('score 0.5 with conflict => reconsolidate', () => {
			expect(classifyRoute(0.5, true)).toBe('reconsolidate')
		})

		it('score 0.0 with conflict => reconsolidate', () => {
			expect(classifyRoute(0.0, true)).toBe('reconsolidate')
		})

		it('score -0.1 with conflict => reconsolidate', () => {
			expect(classifyRoute(-0.1, true)).toBe(
				'reconsolidate'
			)
		})
	})

	// ── Boundary sweep ─────────────────────────────────────────────────────

	describe('boundary sweep across all zones', () => {
		const noConflictCases: Array<[number, ReconRoute]> = [
			[1.0, 'reinforce'],
			[0.99, 'reinforce'],
			[0.95, 'reinforce'],
			[0.92, 'reinforce'],
			[0.9199999, 'reconsolidate'],
			[0.91, 'reconsolidate'],
			[0.85, 'reconsolidate'],
			[0.8, 'reconsolidate'],
			[0.78, 'reconsolidate'],
			[0.7799999, 'new_trace'],
			[0.77, 'new_trace'],
			[0.5, 'new_trace'],
			[0.1, 'new_trace'],
			[0.0, 'new_trace']
		]

		for (const [score, expectedRoute] of noConflictCases) {
			it(`score ${score}, no conflict => ${expectedRoute}`, () => {
				expect(classifyRoute(score, false)).toBe(
					expectedRoute
				)
			})
		}
	})

	// ── Custom policy thresholds ───────────────────────────────────────────

	describe('respects custom policy thresholds', () => {
		it('custom reinforceThreshold lowers reinforce boundary', () => {
			const policy = { reinforceThreshold: 0.85 }
			expect(classifyRoute(0.85, false, policy)).toBe(
				'reinforce'
			)
			expect(classifyRoute(0.84, false, policy)).toBe(
				'reconsolidate'
			)
		})

		it('custom reconsolidateThreshold lowers reconsolidate boundary', () => {
			const policy = { reconsolidateThreshold: 0.6 }
			expect(classifyRoute(0.6, false, policy)).toBe(
				'reconsolidate'
			)
			expect(classifyRoute(0.59, false, policy)).toBe(
				'new_trace'
			)
		})

		it('conflict still overrides custom thresholds', () => {
			const policy = {
				reinforceThreshold: 0.99,
				reconsolidateThreshold: 0.95
			}
			expect(classifyRoute(0.5, true, policy)).toBe(
				'reconsolidate'
			)
		})
	})
})
