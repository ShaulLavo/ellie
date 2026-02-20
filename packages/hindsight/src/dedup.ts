/**
 * Semantic deduplication for memory units.
 *
 * Before inserting new facts, check for semantic duplicates against
 * existing memories in the same bank using embedding similarity.
 */

import { eq } from "drizzle-orm"
import type { HindsightDatabase } from "./db"
import type { EmbeddingStore } from "./embedding"

const DEFAULT_THRESHOLD = 0.92
const DEFAULT_TIME_WINDOW_HOURS = 24

/**
 * Number of nearest neighbors to fetch. We search more than 1 because the
 * closest vector might belong to a different bank — we need to check
 * subsequent hits to find a same-bank duplicate.
 */
const SEARCH_K = 5

/**
 * For each fact, determine if it is a semantic duplicate of an existing memory
 * in the same bank.
 *
 * Returns a boolean array parallel to the input facts array.
 * `true` = duplicate (should be skipped), `false` = novel (should be stored).
 */
export async function findDuplicates(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  facts: Array<{ content: string; temporalAnchor?: number | null }>,
  threshold: number = DEFAULT_THRESHOLD,
  timeWindowHours: number = DEFAULT_TIME_WINDOW_HOURS,
): Promise<boolean[]> {
  const windowMs = Math.max(0, timeWindowHours) * 60 * 60 * 1000
  // Run all vector searches in parallel — they are independent
  const allHits = await Promise.all(
    facts.map((fact) => memoryVec.search(fact.content, SEARCH_K)),
  )

  return allHits.map((hits, factIndex) => {
    const anchor = facts[factIndex]?.temporalAnchor ?? null
    for (const hit of hits) {
      const similarity = 1 - hit.distance
      if (similarity < threshold) break // hits are sorted by distance; no point continuing

      // Verify the hit is in the same bank
      const row = hdb.db
        .select({
          bankId: hdb.schema.memoryUnits.bankId,
          eventDate: hdb.schema.memoryUnits.eventDate,
          occurredStart: hdb.schema.memoryUnits.occurredStart,
          occurredEnd: hdb.schema.memoryUnits.occurredEnd,
          mentionedAt: hdb.schema.memoryUnits.mentionedAt,
          createdAt: hdb.schema.memoryUnits.createdAt,
        })
        .from(hdb.schema.memoryUnits)
        .where(eq(hdb.schema.memoryUnits.id, hit.id))
        .get()

      if (!row || row.bankId !== bankId) continue
      if (anchor == null) return true

      const candidateAnchor =
        row.eventDate ??
        row.occurredStart ??
        row.occurredEnd ??
        row.occurredStart ??
        row.occurredEnd ??
        row.mentionedAt ??
        row.createdAt
      if (Math.abs(anchor - candidateAnchor) <= windowMs) return true
    }
    return false
  })
}
