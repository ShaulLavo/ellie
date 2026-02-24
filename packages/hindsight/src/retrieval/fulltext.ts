import type { HindsightDatabase } from '../db'
import type { TagsMatch } from '../types'
import type { RetrievalHit } from './semantic'

/**
 * Escape special FTS5 characters in a query string.
 * FTS5 operators: AND, OR, NOT, NEAR, *, ^, "
 * We wrap individual terms in quotes for literal matching.
 */
function escapeFts5Query(query: string): string {
	// Split on whitespace, wrap each token in quotes for literal matching
	return query
		.split(/\s+/)
		.filter((t) => t.length > 0)
		.map((t) => `"${t.replace(/"/g, '""')}"`)
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
			.all(safeQuery, bankId, limit) as Array<{ id: string; rank: number }>

		return normalizeRanks(results)
	}

	// With tag filtering — JOIN FTS5 results with memory_units and use json_each
	const mode = tagsMatch ?? 'any'
	const tagPlaceholders = tags.map(() => '?').join(', ')

	let tagCondition: string
	if (mode === 'any') {
		// Has any matching tag OR is untagged
		tagCondition = `(mu.tags IS NULL OR EXISTS (
      SELECT 1 FROM json_each(mu.tags) je WHERE je.value IN (${tagPlaceholders})
    ))`
	} else if (mode === 'all') {
		// Has ALL filter tags OR is untagged
		tagCondition = `(mu.tags IS NULL OR (
      SELECT COUNT(DISTINCT je.value) FROM json_each(mu.tags) je WHERE je.value IN (${tagPlaceholders})
    ) = ${tags.length})`
	} else if (mode === 'any_strict') {
		// Has any matching tag (excludes untagged)
		tagCondition = `(mu.tags IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each(mu.tags) je WHERE je.value IN (${tagPlaceholders})
    ))`
	} else {
		// all_strict: has ALL filter tags (excludes untagged)
		tagCondition = `(mu.tags IS NOT NULL AND (
      SELECT COUNT(DISTINCT je.value) FROM json_each(mu.tags) je WHERE je.value IN (${tagPlaceholders})
    ) = ${tags.length})`
	}

	const results = hdb.sqlite
		.prepare(
			`
      SELECT fts.id, bm25(hs_memory_fts) as rank
      FROM hs_memory_fts fts
      JOIN hs_memory_units mu ON mu.id = fts.id
      WHERE hs_memory_fts MATCH ?
      AND fts.bank_id = ?
      AND ${tagCondition}
      ORDER BY rank
      LIMIT ?
    `
		)
		.all(safeQuery, bankId, ...tags, limit) as Array<{
		id: string
		rank: number
	}>

	return normalizeRanks(results)
}

function normalizeRanks(results: Array<{ id: string; rank: number }>): RetrievalHit[] {
	if (results.length === 0) return []

	// BM25 returns negative scores (more negative = more relevant)
	const minRank = Math.min(...results.map((r) => r.rank))
	const normalizer = minRank < 0 ? -minRank : 1

	return results.map((r) => ({
		id: r.id,
		score: -r.rank / normalizer, // normalize to [0, 1]
		source: 'fulltext'
	}))
}
