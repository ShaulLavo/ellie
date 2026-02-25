import { describe, it, expect } from 'bun:test'
import { scoreCase } from '../scoring'
import type { EvalCase, RecallCandidate } from '../types'

function makeCandidate(content: string, score: number, rank: number): RecallCandidate {
	return {
		memoryId: `mem-${rank}`,
		content,
		score,
		rank,
		sources: ['semantic'],
		factType: 'world'
	}
}

describe('scoring', () => {
	describe('follow_up_recall', () => {
		const evalCase: EvalCase = {
			id: 'test-fur',
			scenario: 'follow_up_recall',
			description: 'test',
			seedFacts: [],
			query: 'test query',
			expected: {
				mustInclude: ['alpha', 'beta']
			}
		}

		it('scores recall@1 correctly when top-1 matches', () => {
			const candidates = [
				makeCandidate('alpha is here', 0.9, 1),
				makeCandidate('gamma is here', 0.8, 2),
				makeCandidate('beta is here', 0.7, 3)
			]
			const metrics = scoreCase(evalCase, candidates)
			expect(metrics['recall@1']).toBe(0.5) // 1 of 2 found in top-1
		})

		it('scores recall@3 correctly', () => {
			const candidates = [
				makeCandidate('alpha is here', 0.9, 1),
				makeCandidate('gamma is here', 0.8, 2),
				makeCandidate('beta is here', 0.7, 3)
			]
			const metrics = scoreCase(evalCase, candidates)
			expect(metrics['recall@3']).toBe(1.0) // both found in top-3
		})

		it('scores MRR correctly', () => {
			const candidates = [
				makeCandidate('gamma is here', 0.9, 1),
				makeCandidate('alpha is here', 0.8, 2),
				makeCandidate('beta is here', 0.7, 3)
			]
			const metrics = scoreCase(evalCase, candidates)
			// MRR = (1/2 + 1/3) / 2 = 0.4166...
			expect(metrics.mrr).toBeCloseTo(0.4167, 3)
		})

		it('handles no matches', () => {
			const candidates = [
				makeCandidate('gamma is here', 0.9, 1),
				makeCandidate('delta is here', 0.8, 2)
			]
			const metrics = scoreCase(evalCase, candidates)
			expect(metrics['recall@1']).toBe(0)
			expect(metrics.mrr).toBe(0)
		})

		it('handles empty mustInclude', () => {
			const emptyCase: EvalCase = {
				...evalCase,
				expected: { mustInclude: [] }
			}
			const candidates = [makeCandidate('anything', 0.9, 1)]
			const metrics = scoreCase(emptyCase, candidates)
			expect(metrics['recall@1']).toBe(1.0)
			expect(metrics.mrr).toBe(1.0)
		})
	})

	describe('temporal_narrative', () => {
		const evalCase: EvalCase = {
			id: 'test-tn',
			scenario: 'temporal_narrative',
			description: 'test',
			seedFacts: [],
			query: 'timeline',
			expected: {
				mustInclude: ['first', 'second', 'third'],
				orderedHints: ['first', 'second', 'third']
			}
		}

		it('scores perfect ordering', () => {
			const candidates = [
				makeCandidate('first event', 0.9, 1),
				makeCandidate('second event', 0.8, 2),
				makeCandidate('third event', 0.7, 3)
			]
			const metrics = scoreCase(evalCase, candidates)
			expect(metrics.orderingAccuracy).toBe(1.0)
			expect(metrics.predecessorHitRate).toBe(1.0)
			expect(metrics.successorHitRate).toBe(1.0)
		})

		it('scores reversed ordering', () => {
			const candidates = [
				makeCandidate('third event', 0.9, 1),
				makeCandidate('second event', 0.8, 2),
				makeCandidate('first event', 0.7, 3)
			]
			const metrics = scoreCase(evalCase, candidates)
			expect(metrics.orderingAccuracy).toBe(0) // all pairs reversed
			expect(metrics.predecessorHitRate).toBe(0) // no predecessor appears before its successor
			expect(metrics.successorHitRate).toBe(0) // no successor appears after its predecessor
		})

		it('scores partial ordering', () => {
			const candidates = [
				makeCandidate('first event', 0.9, 1),
				makeCandidate('third event', 0.8, 2),
				makeCandidate('second event', 0.7, 3)
			]
			const metrics = scoreCase(evalCase, candidates)
			// Pairs: (first,second): idx 0<2 correct, (first,third): idx 0<1 correct, (second,third): idx 2>1 wrong
			expect(metrics.orderingAccuracy).toBeCloseTo(2 / 3, 3)
			// Predecessor: "second"→pred "first" at 0<2 ✓, "third"→pred "second" at 2>1 ✗ → 1/2
			expect(metrics.predecessorHitRate).toBeCloseTo(0.5, 3)
			// Successor: "first"→succ "second" at 2>0 ✓, "second"→succ "third" at 1<2 ✗ → 1/2
			expect(metrics.successorHitRate).toBeCloseTo(0.5, 3)
		})
	})

	describe('dedup_conflict', () => {
		const evalCase: EvalCase = {
			id: 'test-dc',
			scenario: 'dedup_conflict',
			description: 'test',
			seedFacts: [],
			query: 'test',
			expected: {
				mustInclude: ['correct answer'],
				mustExclude: ['old duplicate']
			}
		}

		it('scores 0 duplicate hit ratio when excluded items absent', () => {
			const candidates = [
				makeCandidate('the correct answer is here', 0.9, 1),
				makeCandidate('unrelated content', 0.8, 2)
			]
			const metrics = scoreCase(evalCase, candidates)
			expect(metrics.duplicateLeakRate).toBe(0)
			expect(metrics.contradictionRetrievalRate).toBe(1.0)
		})

		it('scores 1.0 duplicate hit ratio when excluded items present', () => {
			const candidates = [
				makeCandidate('old duplicate entry', 0.9, 1),
				makeCandidate('the correct answer is here', 0.8, 2)
			]
			const metrics = scoreCase(evalCase, candidates)
			expect(metrics.duplicateLeakRate).toBe(1.0)
		})
	})

	describe('code_location_recall', () => {
		const evalCase: EvalCase = {
			id: 'test-clr',
			scenario: 'code_location_recall',
			description: 'test',
			seedFacts: [],
			query: 'where is auth?',
			expected: {
				mustInclude: ['auth/middleware.ts', 'auth/jwt.ts']
			},
			constraints: { topK: 5 }
		}

		it('scores perfect path recall', () => {
			const candidates = [
				makeCandidate('Auth defined in auth/middleware.ts', 0.9, 1),
				makeCandidate('JWT logic in auth/jwt.ts', 0.8, 2),
				makeCandidate('Other file', 0.7, 3)
			]
			const metrics = scoreCase(evalCase, candidates)
			expect(metrics['pathRecall@k']).toBe(1.0)
			expect(metrics.exactPathPrecision).toBeCloseTo(2 / 3, 3)
		})

		it('scores 0 when no paths found', () => {
			const candidates = [
				makeCandidate('unrelated code', 0.9, 1),
				makeCandidate('more unrelated', 0.8, 2)
			]
			const metrics = scoreCase(evalCase, candidates)
			expect(metrics['pathRecall@k']).toBe(0)
		})
	})

	describe('token_budget_packing', () => {
		const evalCase: EvalCase = {
			id: 'test-tbp',
			scenario: 'token_budget_packing',
			description: 'test',
			seedFacts: [],
			query: 'tech stack',
			expected: {
				mustInclude: ['React', 'TypeScript']
			},
			constraints: { tokenBudget: 100 }
		}

		it('scores perfect retention', () => {
			const candidates = [
				makeCandidate('Uses React 19', 0.9, 1),
				makeCandidate('Written in TypeScript', 0.8, 2)
			]
			const metrics = scoreCase(evalCase, candidates)
			expect(metrics.factRetentionRate).toBe(1.0)
			expect(metrics.truncationLossRate).toBe(0)
		})

		it('scores partial retention', () => {
			const candidates = [
				makeCandidate('Uses React 19', 0.9, 1),
				makeCandidate('Something else', 0.8, 2)
			]
			const metrics = scoreCase(evalCase, candidates)
			expect(metrics.factRetentionRate).toBe(0.5)
			expect(metrics.truncationLossRate).toBe(0.5)
		})

		it('computes budget utilization', () => {
			// Short content = low utilization
			const candidates = [makeCandidate('React', 0.9, 1)]
			const metrics = scoreCase(evalCase, candidates)
			// "React" = 5 chars / 4 ≈ 2 tokens, budget = 100
			expect(metrics.budgetUtilization).toBeCloseTo(0.02, 2)
		})
	})
})
