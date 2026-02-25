import type { HindsightDatabase } from '../db'
import type { TagsMatch } from '../types'
import type { RetrievalHit } from './semantic'

/**
 * Time-range retrieval: find memories whose temporal validity overlaps a range.
 *
 * Python parity overlap condition:
 * - (occurred_start <= to AND occurred_end >= from)
 * - OR mentioned_at in range
 * - OR occurred_start in range
 * - OR occurred_end in range
 *
 * Scored by temporal-anchor recency (more recent = higher score).
 * Supports optional tag pre-filtering via json_each().
 */
export function searchTemporal(
	hdb: HindsightDatabase,
	bankId: string,
	timeRange: { from?: number; to?: number } | undefined,
	limit: number,
	tags?: string[],
	tagsMatch?: TagsMatch
): RetrievalHit[] {
	if (!timeRange || (timeRange.from == null && timeRange.to == null)) return []

	const rangeFrom = timeRange.from ?? -8_640_000_000_000_000
	const rangeTo = timeRange.to ?? 8_640_000_000_000_000

	const conditions: string[] = ['bank_id = ?']
	const params: (string | number)[] = [
		bankId,
		// Case 1: both occurrence bounds → overlap check only
		rangeTo,
		rangeFrom,
		// Case 2: incomplete occurrence data → fallback to mentioned_at or partial bounds
		rangeFrom,
		rangeTo,
		rangeFrom,
		rangeTo,
		rangeFrom,
		rangeTo
	]

	// When both occurred_start and occurred_end are present, use only the
	// overlap check (event time is known precisely). Only fall back to
	// mentioned_at / partial bounds when occurrence data is incomplete.
	conditions.push(`(
    (occurred_start IS NOT NULL AND occurred_end IS NOT NULL AND occurred_start <= ? AND occurred_end >= ?)
    OR (
      (occurred_start IS NULL OR occurred_end IS NULL) AND (
        (mentioned_at IS NOT NULL AND mentioned_at BETWEEN ? AND ?)
        OR (occurred_start IS NOT NULL AND occurred_start BETWEEN ? AND ?)
        OR (occurred_end IS NOT NULL AND occurred_end BETWEEN ? AND ?)
      )
    )
  )`)

	// Only include memories that have at least some temporal data.
	conditions.push(
		'(event_date IS NOT NULL OR occurred_start IS NOT NULL OR occurred_end IS NOT NULL OR mentioned_at IS NOT NULL OR occurred_start IS NOT NULL OR occurred_end IS NOT NULL)'
	)

	// Tag pre-filtering
	if (tags && tags.length > 0) {
		const mode = tagsMatch ?? 'any'
		const tagPlaceholders = tags.map(() => '?').join(', ')

		if (mode === 'any') {
			conditions.push(
				`(tags IS NULL OR EXISTS (
          SELECT 1 FROM json_each(tags) je WHERE je.value IN (${tagPlaceholders})
        ))`
			)
		} else if (mode === 'all') {
			conditions.push(
				`(tags IS NULL OR (
          SELECT COUNT(DISTINCT je.value) FROM json_each(tags) je WHERE je.value IN (${tagPlaceholders})
        ) = ${tags.length})`
			)
		} else if (mode === 'any_strict') {
			conditions.push(
				`(tags IS NOT NULL AND EXISTS (
          SELECT 1 FROM json_each(tags) je WHERE je.value IN (${tagPlaceholders})
        ))`
			)
		} else {
			// all_strict
			conditions.push(
				`(tags IS NOT NULL AND (
          SELECT COUNT(DISTINCT je.value) FROM json_each(tags) je WHERE je.value IN (${tagPlaceholders})
        ) = ${tags.length})`
			)
		}

		params.push(...tags)
	}

	const rows = hdb.sqlite
		.prepare(
			`
      SELECT id, event_date, occurred_start, occurred_end, mentioned_at, created_at
      FROM hs_memory_units
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(event_date, occurred_start, mentioned_at, created_at) DESC
      LIMIT ?
    `
		)
		.all(...params, limit) as Array<{
		id: string
		event_date: number | null
		occurred_start: number | null
		occurred_end: number | null
		mentioned_at: number | null
		created_at: number
	}>

	if (rows.length === 0) return []

	const anchors = rows.map(row => {
		if (row.occurred_start != null && row.occurred_end != null) {
			return Math.round((row.occurred_start + row.occurred_end) / 2)
		}
		return (
			row.occurred_start ?? row.occurred_end ?? row.mentioned_at ?? row.event_date ?? row.created_at
		)
	})
	const maxAnchor = Math.max(...anchors)
	const minAnchor = Math.min(...anchors)
	const range = maxAnchor - minAnchor

	return rows.map((row, index) => {
		const anchor = anchors[index]!
		const normalized = range <= 0 ? 1 : Math.max(0, Math.min(1, (anchor - minAnchor) / range))
		return {
			id: row.id,
			score: normalized,
			source: 'temporal'
		}
	})
}
