import type { HindsightDatabase } from '../db'
import type { TagsMatch } from '../types'
import type { RetrievalHit } from './semantic'
import { buildTagCondition } from './tag-filter'

/**
 * Escape special FTS5 characters in a query string.
 * FTS5 operators: AND, OR, NOT, NEAR, *, ^, "
 * We wrap individual terms in quotes for literal matching.
 */
function escapeFts5Query(query: string): string {
	// Split on whitespace, wrap each token in quotes for literal matching
	return query
		.split(/\s+/)
		.filter(t => t.length > 0)
		.map(t => `"${t.replace(/"/g, '""')}"`)
		.join(' OR ')
}

/**
 * Full-text search via FTS5 BM25 scoring with optional tag pre-filtering.
 * Returns memory IDs scored by BM25 relevance, filtered to the target bank.
 */
export function searchFulltext(
	hdb: HindsightDatabase,
	bankId: string,
	query: string,
	limit: number,
	tags?: string[],
	tagsMatch?: TagsMatch
): RetrievalHit[] {
	const safeQuery = escapeFts5Query(query)
	if (!safeQuery) return []

	// No tag filtering — use direct FTS5 query
	if (!tags || tags.length === 0) {
		const results = hdb.sqlite
			.prepare(
				`
        SELECT id, bm25(hs_memory_fts) as rank
        FROM hs_memory_fts
        WHERE hs_memory_fts MATCH ?
        AND bank_id = ?
        ORDER BY rank
        LIMIT ?
      `
			)
			.all(safeQuery, bankId, limit) as Array<{
			id: string
			rank: number
		}>

		return normalizeRanks(results)
	}

	const tagFilter = buildTagCondition(
		tags,
		tagsMatch,
		'mu.tags'
	)

	const results = hdb.sqlite
		.prepare(
			`
      SELECT fts.id, bm25(hs_memory_fts) as rank
      FROM hs_memory_fts fts
      JOIN hs_memory_units mu ON mu.id = fts.id
      WHERE hs_memory_fts MATCH ?
      AND fts.bank_id = ?
      AND ${tagFilter.condition}
      ORDER BY rank
      LIMIT ?
    `
		)
		.all(
			safeQuery,
			bankId,
			...tagFilter.params,
			limit
		) as Array<{
		id: string
		rank: number
	}>

	return normalizeRanks(results)
}

function normalizeRanks(
	results: Array<{ id: string; rank: number }>
): RetrievalHit[] {
	if (results.length === 0) return []

	// BM25 returns negative scores (more negative = more relevant)
	const minRank = Math.min(...results.map(r => r.rank))
	const normalizer = minRank < 0 ? -minRank : 1

	return results.map(r => ({
		id: r.id,
		score: -r.rank / normalizer, // normalize to [0, 1]
		source: 'fulltext'
	}))
}
