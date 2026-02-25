/**
 * Phase 2 Verification — Metric Computation
 *
 * Gate 6: Duplicate Ratio
 *   DR = sum(max(0, canonical_count(cluster_id) - 1)) / sum(canonical_count(cluster_id))
 *
 * Gate 7: Narrative Accuracy
 *   Question is correct if required memory IDs appear in correct order
 *   within narrative(..., steps=12) output.
 *   accuracy = correct_questions / total_questions
 */

import type {
	DuplicateRatioMetrics,
	NarrativeAccuracyMetrics
} from './phase2-types'

// ── Gate 6: Duplicate Ratio ──────────────────────────────────────────────

/**
 * Compute the duplicate ratio for a set of ingest events and their
 * resulting canonical memory cluster counts.
 *
 * @param clusterCounts - Map from clusterId to canonical memory count
 *                        in the database after ingest.
 */
export function computeDuplicateRatio(
	clusterCounts: Map<string, number>
): DuplicateRatioMetrics {
	let totalCanonicalCount = 0
	let totalDuplicates = 0

	for (const count of clusterCounts.values()) {
		totalCanonicalCount += count
		totalDuplicates += Math.max(0, count - 1)
	}

	if (totalCanonicalCount === 0) {
		return {
			totalCanonicalCount: 0,
			totalDuplicates: 0,
			duplicateRatio: 0
		}
	}

	return {
		totalCanonicalCount,
		totalDuplicates,
		duplicateRatio: totalDuplicates / totalCanonicalCount
	}
}

/**
 * Compare baseline and candidate duplicate ratios for Gate 6.
 *
 * Pass criterion: (DR_baseline - DR_phase2) / DR_baseline >= 0.25
 */
export function evaluateGate6(
	baselineDR: number,
	candidateDR: number
): {
	pass: boolean
	reduction: number
	reductionPercent: number
} {
	if (baselineDR === 0) {
		return {
			pass: false,
			reduction: 0,
			reductionPercent: 0
		}
	}

	const reduction = baselineDR - candidateDR
	const reductionPercent = reduction / baselineDR

	return {
		pass: reductionPercent >= 0.25,
		reduction,
		reductionPercent
	}
}

// ── Gate 7: Narrative Accuracy ───────────────────────────────────────────

/**
 * Evaluate whether a single narrative question is answered correctly.
 *
 * A question is correct if all required memory IDs appear in the narrative
 * events AND in the correct relative order.
 *
 * @param expectedIds - Ordered list of memory IDs expected in the narrative
 * @param narrativeMemoryIds - Actual memory IDs from the narrative response
 */
export function isNarrativeQuestionCorrect(
	expectedIds: string[],
	narrativeMemoryIds: string[]
): boolean {
	if (expectedIds.length === 0) return true

	// All expected IDs must appear in the narrative
	for (const expectedId of expectedIds) {
		if (!narrativeMemoryIds.includes(expectedId)) {
			return false
		}
	}

	// Check ordering: expected IDs must appear in the same relative order
	let lastIndex = -1
	for (const expectedId of expectedIds) {
		const index = narrativeMemoryIds.indexOf(expectedId)
		if (index <= lastIndex) return false
		lastIndex = index
	}

	return true
}

/**
 * Compute narrative accuracy across a set of questions.
 */
export function computeNarrativeAccuracy(
	results: Array<{ correct: boolean }>
): NarrativeAccuracyMetrics {
	const totalQuestions = results.length
	const correctQuestions = results.filter(
		r => r.correct
	).length

	return {
		totalQuestions,
		correctQuestions,
		accuracy:
			totalQuestions > 0
				? correctQuestions / totalQuestions
				: 0
	}
}

/**
 * Compare baseline and candidate narrative accuracy for Gate 7.
 *
 * Pass criterion: (ACC_phase2 - ACC_baseline) / ACC_baseline >= 0.15
 */
export function evaluateGate7(
	baselineAcc: number,
	candidateAcc: number
): {
	pass: boolean
	improvement: number
	improvementPercent: number
} {
	if (baselineAcc === 0) {
		return {
			pass: false,
			improvement: 0,
			improvementPercent: 0
		}
	}

	const improvement = candidateAcc - baselineAcc
	const improvementPercent = improvement / baselineAcc

	return {
		pass: improvementPercent >= 0.15,
		improvement,
		improvementPercent
	}
}
