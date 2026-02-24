import type { RetrievalHit } from './retrieval/semantic'

const K = 60 // Standard RRF constant

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
	const fused = new Map<string, { score: number; sources: Set<string> }>()

	for (const results of resultSets) {
		for (let rank = 0; rank < results.length; rank++) {
			const hit = results[rank]!
			const rrfScore = 1 / (K + rank + 1)

			const existing = fused.get(hit.id)
			if (existing) {
				existing.score += rrfScore
				existing.sources.add(hit.source)
			} else {
				fused.set(hit.id, {
					score: rrfScore,
					sources: new Set([hit.source])
				})
			}
		}
	}

	return Array.from(fused.entries())
		.map(([id, { score, sources }]) => ({
			id,
			score,
			sources: Array.from(sources)
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
}
