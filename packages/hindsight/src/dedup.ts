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
    const hits = await memoryVec.search(fact.content, 1)

    if (hits.length > 0) {
      const similarity = 1 - hits[0]!.distance
      // Verify the hit is in the same bank
      const row = hdb.db
        .select({ bankId: hdb.schema.memoryUnits.bankId })
        .from(hdb.schema.memoryUnits)
        .where(eq(hdb.schema.memoryUnits.id, hits[0]!.id))
        .get()

      isDuplicate.push(row?.bankId === bankId && similarity >= threshold)
    } else {
      isDuplicate.push(false)
    }
  }

  return isDuplicate
}
