import type { HindsightDatabase } from "../db"
import type { TagsMatch } from "../types"
import type { RetrievalHit } from "./semantic"

/**
 * Time-range retrieval: find memories whose temporal validity overlaps a range.
 *
 * Overlap condition:
 *   (valid_from <= range.to OR valid_from IS NULL)
 *   AND (valid_to >= range.from OR valid_to IS NULL)
 *
 * Scored by recency (more recent = higher score).
 * Supports optional tag pre-filtering via json_each().
 */
export function searchTemporal(
  hdb: HindsightDatabase,
  bankId: string,
  timeRange: { from?: number; to?: number } | undefined,
  limit: number,
  tags?: string[],
  tagsMatch?: TagsMatch,
): RetrievalHit[] {
  if (!timeRange || (timeRange.from == null && timeRange.to == null)) return []

  const conditions: string[] = ["bank_id = ?"]
  const params: (string | number)[] = [bankId]

  if (timeRange.from != null) {
    conditions.push("(valid_to >= ? OR valid_to IS NULL)")
    params.push(timeRange.from)
  }
  if (timeRange.to != null) {
    conditions.push("(valid_from <= ? OR valid_from IS NULL)")
    params.push(timeRange.to)
  }

  // Only include memories that have at least some temporal data
  conditions.push("(valid_from IS NOT NULL OR valid_to IS NOT NULL)")

  // Tag pre-filtering
  if (tags && tags.length > 0) {
    const mode = tagsMatch ?? "any"
    const tagPlaceholders = tags.map(() => "?").join(", ")

    if (mode === "any") {
      conditions.push(
        `(tags IS NULL OR EXISTS (
          SELECT 1 FROM json_each(tags) je WHERE je.value IN (${tagPlaceholders})
        ))`,
      )
    } else if (mode === "all") {
      conditions.push(
        `(tags IS NULL OR (
          SELECT COUNT(DISTINCT je.value) FROM json_each(tags) je WHERE je.value IN (${tagPlaceholders})
        ) = ${tags.length})`,
      )
    } else if (mode === "any_strict") {
      conditions.push(
        `(tags IS NOT NULL AND EXISTS (
          SELECT 1 FROM json_each(tags) je WHERE je.value IN (${tagPlaceholders})
        ))`,
      )
    } else {
      // all_strict
      conditions.push(
        `(tags IS NOT NULL AND (
          SELECT COUNT(DISTINCT je.value) FROM json_each(tags) je WHERE je.value IN (${tagPlaceholders})
        ) = ${tags.length})`,
      )
    }

    params.push(...tags)
  }

  const rows = hdb.sqlite
    .prepare(
      `
      SELECT id, created_at FROM hs_memory_units
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `,
    )
    .all(...params, limit) as Array<{ id: string; created_at: number }>

  if (rows.length === 0) return []

  // Position-based scoring: first result = 1.0, last = close to 0
  return rows.map((r, i) => ({
    id: r.id,
    score: 1 - i / Math.max(rows.length, 1),
    source: "temporal",
  }))
}
