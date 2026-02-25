/**
 * Scenario-specific scoring metrics for the Hindsight eval harness.
 *
 * Each scenario family has specialized metrics:
 * - follow_up_recall: Recall@1/3/5, MRR
 * - temporal_narrative: ordering accuracy, predecessor/successor hit rate
 * - dedup_conflict: duplicate leak rate (penalty), contradiction retrieval rate
 * - code_location_recall: path Recall@k, exact-path precision
 * - token_budget_packing: fact retention rate, truncation loss rate
 */

import type { EvalCase, RecallCandidate, Scenario } from './types'

// ── Generic scoring helpers ───────────────────────────────────────────────

/**
 * Check if a candidate's content contains a substring (case-insensitive).
 */
function contentContains(candidate: RecallCandidate, substring: string): boolean {
	return candidate.content.toLowerCase().includes(substring.toLowerCase())
}

/**
 * Recall@K: fraction of expected items found in top-K candidates.
 */
function recallAtK(candidates: RecallCandidate[], mustInclude: string[], k: number): number {
	if (mustInclude.length === 0) return 1.0
	const topK = candidates.slice(0, k)
	const found = mustInclude.filter(expected => topK.some(c => contentContains(c, expected)))
	return found.length / mustInclude.length
}

/**
 * Mean Reciprocal Rank: average of 1/rank for each expected item.
 */
function meanReciprocalRank(candidates: RecallCandidate[], mustInclude: string[]): number {
	if (mustInclude.length === 0) return 1.0
	let rrSum = 0
	for (const expected of mustInclude) {
		const idx = candidates.findIndex(c => contentContains(c, expected))
		if (idx >= 0) {
			rrSum += 1 / (idx + 1)
		}
	}
	return rrSum / mustInclude.length
}

// ── Scenario-specific scorers ─────────────────────────────────────────────

function scoreFollowUpRecall(
	evalCase: EvalCase,
	candidates: RecallCandidate[]
): Record<string, number> {
	const mustInclude = evalCase.expected.mustInclude ?? []
	return {
		'recall@1': recallAtK(candidates, mustInclude, 1),
		'recall@3': recallAtK(candidates, mustInclude, 3),
		'recall@5': recallAtK(candidates, mustInclude, 5),
		mrr: meanReciprocalRank(candidates, mustInclude)
	}
}

function scoreTemporalNarrative(
	evalCase: EvalCase,
	candidates: RecallCandidate[]
): Record<string, number> {
	const orderedHints = evalCase.expected.orderedHints ?? []
	const mustInclude = evalCase.expected.mustInclude ?? []

	// Ordering accuracy: fraction of hint pairs in correct relative order
	let correctPairs = 0
	let totalPairs = 0
	for (let i = 0; i < orderedHints.length; i++) {
		for (let j = i + 1; j < orderedHints.length; j++) {
			totalPairs++
			const idxI = candidates.findIndex(c => contentContains(c, orderedHints[i]!))
			const idxJ = candidates.findIndex(c => contentContains(c, orderedHints[j]!))
			if (idxI >= 0 && idxJ >= 0 && idxI < idxJ) {
				correctPairs++
			}
		}
	}
	const orderingAccuracy = totalPairs > 0 ? correctPairs / totalPairs : 1.0

	// Predecessor hit rate: for each hint at position i>0, check that
	// hint[i-1] appears at a LOWER rank (earlier in candidates) than hint[i]
	let predecessorHits = 0
	let predecessorTotal = 0
	for (let i = 1; i < orderedHints.length; i++) {
		const currentIdx = candidates.findIndex(c => contentContains(c, orderedHints[i]!))
		const prevIdx = candidates.findIndex(c => contentContains(c, orderedHints[i - 1]!))
		if (currentIdx >= 0 && prevIdx >= 0) {
			predecessorTotal++
			if (prevIdx < currentIdx) predecessorHits++
		}
	}
	const predecessorHitRate = predecessorTotal > 0 ? predecessorHits / predecessorTotal : 1.0

	// Successor hit rate: for each hint at position i<N-1, check that
	// hint[i+1] appears at a HIGHER rank (later in candidates) than hint[i]
	let successorHits = 0
	let successorTotal = 0
	for (let i = 0; i < orderedHints.length - 1; i++) {
		const currentIdx = candidates.findIndex(c => contentContains(c, orderedHints[i]!))
		const nextIdx = candidates.findIndex(c => contentContains(c, orderedHints[i + 1]!))
		if (currentIdx >= 0 && nextIdx >= 0) {
			successorTotal++
			if (nextIdx > currentIdx) successorHits++
		}
	}
	const successorHitRate = successorTotal > 0 ? successorHits / successorTotal : 1.0

	return {
		orderingAccuracy,
		predecessorHitRate,
		successorHitRate,
		'recall@5': recallAtK(candidates, mustInclude, 5)
	}
}

function scoreDedupConflict(
	evalCase: EvalCase,
	candidates: RecallCandidate[]
): Record<string, number> {
	const mustInclude = evalCase.expected.mustInclude ?? []
	const mustExclude = evalCase.expected.mustExclude ?? []

	// Duplicate hit ratio: fraction of excluded (duplicate) items that still appear
	const duplicateHits = mustExclude.filter(excluded =>
		candidates.some(c => contentContains(c, excluded))
	).length
	const duplicateLeakRate = mustExclude.length > 0 ? duplicateHits / mustExclude.length : 0

	// Contradiction retrieval rate: how many expected items were actually retrieved
	const contradictionRetrievalRate = recallAtK(candidates, mustInclude, candidates.length)

	return {
		duplicateLeakRate,
		contradictionRetrievalRate,
		'recall@5': recallAtK(candidates, mustInclude, 5)
	}
}

function scoreCodeLocationRecall(
	evalCase: EvalCase,
	candidates: RecallCandidate[]
): Record<string, number> {
	const mustInclude = evalCase.expected.mustInclude ?? []

	// Path recall@k: fraction of expected path references found
	const pathRecallAtK = recallAtK(candidates, mustInclude, candidates.length)

	// Exact path precision: fraction of top-k candidates that match an expected path
	const topK = candidates.slice(0, evalCase.constraints?.topK ?? 10)
	const exactMatches = topK.filter(c =>
		mustInclude.some(expected => contentContains(c, expected))
	).length
	const exactPathPrecision = topK.length > 0 ? exactMatches / topK.length : 0

	return {
		'pathRecall@k': pathRecallAtK,
		exactPathPrecision,
		mrr: meanReciprocalRank(candidates, mustInclude)
	}
}

function scoreTokenBudgetPacking(
	evalCase: EvalCase,
	candidates: RecallCandidate[]
): Record<string, number> {
	const mustInclude = evalCase.expected.mustInclude ?? []
	const tokenBudget = evalCase.constraints?.tokenBudget

	// Fact retention rate: how many expected facts made it into the budget
	const factRetentionRate = recallAtK(candidates, mustInclude, candidates.length)

	// Truncation loss rate: proportion of expected facts NOT in results
	const truncationLossRate = 1 - factRetentionRate

	// Actual tokens used (approximate: content length / 4)
	const tokensUsed = candidates.reduce((sum, c) => sum + Math.ceil(c.content.length / 4), 0)
	const budgetUtilization =
		tokenBudget && tokenBudget > 0 ? Math.min(tokensUsed / tokenBudget, 1) : 0

	return {
		factRetentionRate,
		truncationLossRate,
		budgetUtilization
	}
}

// ── Main scorer dispatch ──────────────────────────────────────────────────

const SCORERS: Record<
	Scenario,
	(evalCase: EvalCase, candidates: RecallCandidate[]) => Record<string, number>
> = {
	follow_up_recall: scoreFollowUpRecall,
	temporal_narrative: scoreTemporalNarrative,
	dedup_conflict: scoreDedupConflict,
	code_location_recall: scoreCodeLocationRecall,
	token_budget_packing: scoreTokenBudgetPacking
}

/**
 * Score a single eval case using scenario-appropriate metrics.
 */
export function scoreCase(
	evalCase: EvalCase,
	candidates: RecallCandidate[]
): Record<string, number> {
	const scorer = SCORERS[evalCase.scenario]
	return scorer(evalCase, candidates)
}
