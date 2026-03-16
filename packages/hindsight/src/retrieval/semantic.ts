import { eq, inArray, and } from 'drizzle-orm'
import type { HindsightDatabase } from '../db'
import type { EmbeddingStore } from '../embedding'

export interface RetrievalHit {
	id: string
	score: number
	source: string
}

/**
 * Vector similarity search via sqlite-vec.
 * Returns memory IDs scored by cosine similarity, filtered to the target bank.
 */
export async function searchSemantic(
	hdb: HindsightDatabase,
	memoryVec: EmbeddingStore,
	bankId: string,
	query: string,
	limit: number
): Promise<RetrievalHit[]> {
	// Fetch extra candidates since we'll filter by bank
	const results = await memoryVec.search(query, limit * 3)
	if (results.length === 0) return []

	// Single batch query to filter by bankId
	const candidateIds = results.map(r => r.id)
	const matchingRows = hdb.db
		.select({ id: hdb.schema.memoryUnits.id })
		.from(hdb.schema.memoryUnits)
		.where(
			and(
				inArray(hdb.schema.memoryUnits.id, candidateIds),
				eq(hdb.schema.memoryUnits.bankId, bankId)
			)
		)
		.all()

	const matchingIds = new Set(matchingRows.map(r => r.id))

	const hits: RetrievalHit[] = []
	for (const r of results) {
		if (hits.length >= limit) break
		if (!matchingIds.has(r.id)) continue
		hits.push({
			id: r.id,
			score: 1 - r.distance, // cosine distance [0,2] → similarity [-1,1]
			source: 'semantic'
		})
	}

	return hits
}
