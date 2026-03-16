import type { RetrievalHit } from './retrieval/semantic'

const DEFAULT_K = 60 // Standard RRF constant

/**
 * Low-level RRF accumulation: given ranked ID lists, returns fused scores.
 *
 * Each list is an array of IDs in rank order. Score for each ID =
 * sum of 1/(k + rank + 1) across all lists it appears in.
 */
export function rrfCore(
	rankedLists: string[][],
	k: number = DEFAULT_K
): Map<string, number> {
	const fused = new Map<string, number>()
	for (const list of rankedLists) {
		for (let rank = 0; rank < list.length; rank++) {
			const id = list[rank]!
			const rrfScore = 1 / (k + rank + 1)
			fused.set(id, (fused.get(id) ?? 0) + rrfScore)
		}
	}
	return fused
}

/**
 * Reciprocal Rank Fusion: merges multiple ranked lists into a single scored list.
 *
 * RRF score for each document = sum of 1/(K + rank + 1) across all lists.
 * Documents appearing in multiple lists get boosted.
 */
export function reciprocalRankFusion(
	resultSets: RetrievalHit[][],
	limit: number
): Array<{ id: string; score: number; sources: string[] }> {
	// Build source tracking alongside core fusion
	const sourceMap = new Map<string, Set<string>>()
	for (const results of resultSets) {
		for (const hit of results) {
			const existing = sourceMap.get(hit.id)
			if (existing) {
				existing.add(hit.source)
			} else {
				sourceMap.set(hit.id, new Set([hit.source]))
			}
		}
	}

	const rankedLists = resultSets.map(results =>
		results.map(h => h.id)
	)
	const fused = rrfCore(rankedLists)

	return Array.from(fused.entries())
		.map(([id, score]) => ({
			id,
			score,
			sources: Array.from(sourceMap.get(id)!)
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
}
