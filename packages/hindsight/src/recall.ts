import { eq } from "drizzle-orm"
import type { HindsightDatabase } from "./db"
import type { EmbeddingStore } from "./embedding"
import type {
  RecallOptions,
  RecallResult,
  ScoredMemory,
  FactType,
  TagsMatch,
} from "./types"
import type { RetrievalHit } from "./retrieval/semantic"
import { searchSemantic } from "./retrieval/semantic"
import { searchFulltext } from "./retrieval/fulltext"
import { searchGraph } from "./retrieval/graph"
import { searchTemporal } from "./retrieval/temporal"
import { reciprocalRankFusion } from "./fusion"
import { rowToMemoryUnit, rowToEntity } from "./retain"
import { extractTemporalRange } from "./temporal"

/**
 * Multi-strategy retrieval with Reciprocal Rank Fusion.
 *
 * Runs up to 4 retrieval strategies in parallel:
 * 1. Semantic (sqlite-vec KNN)
 * 2. Fulltext (FTS5 BM25)
 * 3. Graph (entity/link BFS)
 * 4. Temporal (time-range filter)
 *
 * Results are merged via RRF, hydrated with full memory + entity data,
 * then post-filtered by tags, confidence, factType, and entity names.
 */
export async function recall(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  query: string,
  options: RecallOptions = {},
): Promise<RecallResult> {
  const limit = options.limit ?? 10
  const methods = options.methods ?? [
    "semantic",
    "fulltext",
    "graph",
    "temporal",
  ]
  const candidateLimit = limit * 3

  // Auto-extract temporal range from query if not explicitly provided
  const timeRange = options.timeRange ?? extractTemporalRange(query)

  // Run retrieval methods in parallel
  const promises: Array<Promise<RetrievalHit[]>> = []

  if (methods.includes("semantic")) {
    promises.push(
      searchSemantic(hdb, memoryVec, bankId, query, candidateLimit),
    )
  }
  if (methods.includes("fulltext")) {
    promises.push(
      Promise.resolve(
        searchFulltext(hdb, bankId, query, candidateLimit, options.tags, options.tagsMatch),
      ),
    )
  }
  if (methods.includes("graph")) {
    promises.push(
      Promise.resolve(searchGraph(hdb, bankId, query, candidateLimit)),
    )
  }
  if (methods.includes("temporal")) {
    promises.push(
      Promise.resolve(
        searchTemporal(hdb, bankId, timeRange, candidateLimit, options.tags, options.tagsMatch),
      ),
    )
  }

  const resultSets = await Promise.all(promises)

  // Merge via Reciprocal Rank Fusion
  const fused = reciprocalRankFusion(resultSets, limit * 2)

  // Hydrate full memory objects with entities, apply filters
  const memories: ScoredMemory[] = []

  for (const { id, score, sources } of fused) {
    if (memories.length >= limit) break

    const row = hdb.db
      .select()
      .from(hdb.schema.memoryUnits)
      .where(eq(hdb.schema.memoryUnits.id, id))
      .get()

    if (!row) continue

    // Apply filters
    if (
      options.minConfidence != null &&
      row.confidence < options.minConfidence
    ) {
      continue
    }
    if (
      options.factTypes &&
      !options.factTypes.includes(row.factType as FactType)
    ) {
      continue
    }

    // Tag filter (post-filter for semantic + graph; fulltext + temporal pre-filter too)
    if (options.tags && options.tags.length > 0) {
      let memoryTags: string[] = []
      try {
        memoryTags = row.tags ? JSON.parse(row.tags) : []
      } catch {
        // malformed tags — treat as untagged
      }
      if (!matchesTags(memoryTags, options.tags, options.tagsMatch ?? "any")) {
        continue
      }
    }

    // Fetch associated entities
    const junctions = hdb.db
      .select()
      .from(hdb.schema.memoryEntities)
      .where(eq(hdb.schema.memoryEntities.memoryId, id))
      .all()

    const entityRows = junctions
      .map((j) =>
        hdb.db
          .select()
          .from(hdb.schema.entities)
          .where(eq(hdb.schema.entities.id, j.entityId))
          .get(),
      )
      .filter(Boolean)

    // Entity name filter
    if (options.entities && options.entities.length > 0) {
      const entityNames = new Set(
        entityRows.map((e) => e!.name.toLowerCase()),
      )
      const hasMatch = options.entities.some((n) =>
        entityNames.has(n.toLowerCase()),
      )
      if (!hasMatch) continue
    }

    memories.push({
      memory: rowToMemoryUnit(row),
      score,
      sources: sources as ScoredMemory["sources"],
      entities: entityRows.map((e) => rowToEntity(e!)),
    })
  }

  return { memories, query }
}

// ── Tag matching ──────────────────────────────────────────────────────────

/**
 * Check if a memory's tags match the filter tags according to the given mode.
 *
 * Modes:
 * - "any": memory has any matching tag OR is untagged (most permissive)
 * - "all": memory has ALL filter tags (untagged memories are included)
 * - "any_strict": memory has any matching tag (excludes untagged)
 * - "all_strict": memory has ALL filter tags (excludes untagged)
 */
export function matchesTags(
  memoryTags: string[],
  filterTags: string[],
  mode: TagsMatch,
): boolean {
  if (filterTags.length === 0) return true

  const isUntagged = memoryTags.length === 0

  switch (mode) {
    case "any":
      return isUntagged || memoryTags.some((t) => filterTags.includes(t))
    case "all":
      return isUntagged || filterTags.every((t) => memoryTags.includes(t))
    case "any_strict":
      return !isUntagged && memoryTags.some((t) => filterTags.includes(t))
    case "all_strict":
      return !isUntagged && filterTags.every((t) => memoryTags.includes(t))
  }
}
