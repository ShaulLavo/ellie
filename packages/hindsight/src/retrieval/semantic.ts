import { eq } from "drizzle-orm"
import type { HindsightDatabase } from "../db"
import type { EmbeddingStore } from "../embedding"

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
  limit: number,
): Promise<RetrievalHit[]> {
  // Fetch extra candidates since we'll filter by bank
  const results = await memoryVec.search(query, limit * 3)

  const hits: RetrievalHit[] = []
  for (const r of results) {
    if (hits.length >= limit) break

    const row = hdb.db
      .select({ bankId: hdb.schema.memoryUnits.bankId })
      .from(hdb.schema.memoryUnits)
      .where(eq(hdb.schema.memoryUnits.id, r.id))
      .get()

    if (row?.bankId === bankId) {
      hits.push({
        id: r.id,
        score: 1 - r.distance, // cosine distance [0,2] → similarity [-1,1]
        source: "semantic",
      })
    }
  }

  return hits
}
