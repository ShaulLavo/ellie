import { eq, or } from "drizzle-orm"
import type { HindsightDatabase } from "../db"
import type { RetrievalHit } from "./semantic"

/**
 * Graph-based retrieval via BFS over entity and link connections.
 *
 * 1. Find entities mentioned in the query (substring match against entity names)
 * 2. Find memories linked to those entities
 * 3. BFS: follow memory_links 1 hop from seed memories
 * 4. Score by proximity: seeds=1.0, 1-hop=weight*0.5
 */
export function searchGraph(
  hdb: HindsightDatabase,
  bankId: string,
  query: string,
  limit: number,
): RetrievalHit[] {
  const { schema } = hdb
  const queryLower = query.toLowerCase()

  // Step 1: Find entities whose name appears in the query
  const allEntities = hdb.db
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.bankId, bankId))
    .all()

  const seedEntities = allEntities.filter((e) =>
    queryLower.includes(e.name.toLowerCase()),
  )

  if (seedEntities.length === 0) return []

  // Step 2: Find memories linked to seed entities
  const seedMemoryIds = new Set<string>()
  for (const entity of seedEntities) {
    const junctions = hdb.db
      .select()
      .from(schema.memoryEntities)
      .where(eq(schema.memoryEntities.entityId, entity.id))
      .all()
    for (const j of junctions) seedMemoryIds.add(j.memoryId)
  }

  if (seedMemoryIds.size === 0) return []

  // Step 3: BFS — seeds get 1.0, 1-hop neighbors get weight * 0.5
  const scored = new Map<string, number>()
  for (const id of seedMemoryIds) scored.set(id, 1.0)

  for (const sourceId of seedMemoryIds) {
    const outgoing = hdb.db
      .select()
      .from(schema.memoryLinks)
      .where(
        or(
          eq(schema.memoryLinks.sourceId, sourceId),
          eq(schema.memoryLinks.targetId, sourceId),
        ),
      )
      .all()

    for (const link of outgoing) {
      const neighborId =
        link.sourceId === sourceId ? link.targetId : link.sourceId
      if (!seedMemoryIds.has(neighborId)) {
        const current = scored.get(neighborId) ?? 0
        scored.set(neighborId, current + link.weight * 0.5)
      }
    }
  }

  return Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ id, score, source: "graph" }))
}
