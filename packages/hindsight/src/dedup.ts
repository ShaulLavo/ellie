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
  facts: Array<{ content: string }>,
  threshold: number = DEFAULT_THRESHOLD,
): Promise<boolean[]> {
  const isDuplicate: boolean[] = []

  for (const fact of facts) {
    const hits = await memoryVec.search(fact.content, SEARCH_K)

    let found = false
    for (const hit of hits) {
      const similarity = 1 - hit.distance
      if (similarity < threshold) break // hits are sorted by distance; no point continuing

      // Verify the hit is in the same bank
      const row = hdb.db
        .select({ bankId: hdb.schema.memoryUnits.bankId })
        .from(hdb.schema.memoryUnits)
        .where(eq(hdb.schema.memoryUnits.id, hit.id))
        .get()

      if (row?.bankId === bankId) {
        found = true
        break
      }
    }

    isDuplicate.push(found)
  }

  return isDuplicate
}
