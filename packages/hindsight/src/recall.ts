import { eq, inArray } from "drizzle-orm"
import type { HindsightDatabase } from "./db"
import type { EmbeddingStore } from "./embedding"
import type {
  RecallOptions,
  RecallResult,
  ScoredMemory,
  FactType,
  TagsMatch,
  RerankFunction,
  RecallEntityState,
  RecallChunk,
} from "./types"
import type { RetrievalHit } from "./retrieval/semantic"
import { searchSemantic } from "./retrieval/semantic"
import { searchFulltext } from "./retrieval/fulltext"
import { searchGraph } from "./retrieval/graph"
import { searchTemporal } from "./retrieval/temporal"
import { reciprocalRankFusion } from "./fusion"
import { rerankCandidates } from "./rerank"
import { rowToMemoryUnit, rowToEntity } from "./retain"
import { extractTemporalRange } from "./temporal"

/**
 * Multi-strategy retrieval with Reciprocal Rank Fusion.
 *
 * Runs up to 4 retrieval strategies in parallel:
 * 1. Semantic (sqlite-vec KNN)
 * 2. Fulltext (FTS5 BM25)
 * 3. Graph (link expansion: entity + causal + observation traversal)
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
  rerank?: RerankFunction,
): Promise<RecallResult> {
  const limit = options.limit ?? 10
  const maxTokens = options.maxTokens
  const methods = options.methods ?? [
    "semantic",
    "fulltext",
    "graph",
    "temporal",
  ]
  const candidateLimit = limit * 3

  // Auto-extract temporal range from query if not explicitly provided
  const timeRange = options.timeRange ?? extractTemporalRange(query)

  const methodSet = new Set(methods)
  const semanticPromise = methodSet.has("semantic")
    ? searchSemantic(hdb, memoryVec, bankId, query, candidateLimit)
    : Promise.resolve<RetrievalHit[]>([])
  const fulltextPromise = methodSet.has("fulltext")
    ? Promise.resolve(
        searchFulltext(
          hdb,
          bankId,
          query,
          candidateLimit,
          options.tags,
          options.tagsMatch,
        ),
      )
    : Promise.resolve<RetrievalHit[]>([])
  const temporalPromise = methodSet.has("temporal")
    ? Promise.resolve(
        searchTemporal(
          hdb,
          bankId,
          timeRange,
          candidateLimit,
          options.tags,
          options.tagsMatch,
        ),
      )
    : Promise.resolve<RetrievalHit[]>([])

  const [semanticHits, fulltextHits, temporalHits] = await Promise.all([
    semanticPromise,
    fulltextPromise,
    temporalPromise,
  ])

  const graphHits = methodSet.has("graph")
    ? await searchGraph(hdb, memoryVec, bankId, query, candidateLimit, {
        factTypes: options.factTypes,
        tags: options.tags,
        tagsMatch: options.tagsMatch,
        temporalSeedMemoryIds: temporalHits.map((hit) => hit.id),
      })
    : []

  const resultSets: RetrievalHit[][] = []
  if (methodSet.has("semantic")) resultSets.push(semanticHits)
  if (methodSet.has("fulltext")) resultSets.push(fulltextHits)
  if (methodSet.has("graph")) resultSets.push(graphHits)
  if (methodSet.has("temporal")) resultSets.push(temporalHits)

  // Merge via Reciprocal Rank Fusion
  const fused = reciprocalRankFusion(resultSets, limit * 2)

  // Optional: Cross-encoder reranking
  let ranked = fused
  if (rerank) {
    const contentMap = new Map<string, string>()
    for (const { id } of fused) {
      const row = hdb.db
        .select({ id: hdb.schema.memoryUnits.id, content: hdb.schema.memoryUnits.content })
        .from(hdb.schema.memoryUnits)
        .where(eq(hdb.schema.memoryUnits.id, id))
        .get()
      if (row) contentMap.set(row.id, row.content)
    }
    ranked = await rerankCandidates(rerank, query, fused, contentMap)
  }

  // Hydrate full memory objects with entities, apply filters
  const memories: ScoredMemory[] = []
  const entityStates = new Map<string, {
    id: string
    name: string
    entityType: ScoredMemory["entities"][number]["entityType"]
    memoryIds: Set<string>
  }>()
  let usedTokens = 0

  for (const { id, score, sources } of ranked) {
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

    if (maxTokens != null) {
      const contentTokens = estimateTokens(row.content)
      if (usedTokens + contentTokens > maxTokens) break
      usedTokens += contentTokens
    }

    memories.push({
      memory: rowToMemoryUnit(row),
      score,
      sources: sources as ScoredMemory["sources"],
      entities: entityRows.map((e) => rowToEntity(e!)),
    })

    if (options.includeEntities) {
      for (const entityRow of entityRows) {
        if (!entityRow) continue
        const entity = rowToEntity(entityRow)
        const existing = entityStates.get(entity.id)
        if (existing) {
          existing.memoryIds.add(row.id)
          continue
        }
        entityStates.set(entity.id, {
          id: entity.id,
          name: entity.name,
          entityType: entity.entityType,
          memoryIds: new Set([row.id]),
        })
      }
    }
  }

  const entities = options.includeEntities
    ? buildEntityPayload(entityStates, options.maxEntityTokens)
    : undefined

  const chunks = options.includeChunks
    ? buildChunkPayload(hdb, memories, options.maxChunkTokens)
    : undefined

  return { memories, query, entities, chunks }
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function buildEntityPayload(
  entityStates: Map<string, {
    id: string
    name: string
    entityType: ScoredMemory["entities"][number]["entityType"]
    memoryIds: Set<string>
  }>,
  maxEntityTokens?: number,
): Record<string, RecallEntityState> {
  const payload: Record<string, RecallEntityState> = {}
  let usedTokens = 0

  for (const [entityId, entityState] of entityStates.entries()) {
    const memoryIds = Array.from(entityState.memoryIds)
    const tokenCost = estimateTokens(entityState.name) + memoryIds.length
    if (maxEntityTokens != null && usedTokens + tokenCost > maxEntityTokens) {
      break
    }
    usedTokens += tokenCost
    payload[entityId] = {
      id: entityState.id,
      name: entityState.name,
      entityType: entityState.entityType,
      memoryIds,
    }
  }

  return payload
}

function buildChunkPayload(
  hdb: HindsightDatabase,
  memories: ScoredMemory[],
  maxChunkTokens: number = 8192,
): Record<string, RecallChunk> {
  const payload: Record<string, RecallChunk> = {}
  const chunkIdsOrdered: string[] = []
  const memoryIdByChunkId = new Map<string, string>()

  for (const scored of memories) {
    if (!scored.memory.chunkId) continue
    if (memoryIdByChunkId.has(scored.memory.chunkId)) continue
    memoryIdByChunkId.set(scored.memory.chunkId, scored.memory.id)
    chunkIdsOrdered.push(scored.memory.chunkId)
  }

  const chunkRows =
    chunkIdsOrdered.length > 0
      ? hdb.db
          .select({
            id: hdb.schema.chunks.id,
            documentId: hdb.schema.chunks.documentId,
            chunkIndex: hdb.schema.chunks.chunkIndex,
            content: hdb.schema.chunks.content,
          })
          .from(hdb.schema.chunks)
          .where(inArray(hdb.schema.chunks.id, chunkIdsOrdered))
          .all()
      : []
  const chunkById = new Map(chunkRows.map((row) => [row.id, row]))

  let usedTokens = 0

  for (const chunkId of chunkIdsOrdered) {
    const row = chunkById.get(chunkId)
    if (!row) continue
    const memoryId = memoryIdByChunkId.get(chunkId)
    if (!memoryId) continue

    const chunkContent = row.content
    const chunkTokens = estimateTokens(chunkContent)
    if (usedTokens + chunkTokens > maxChunkTokens) {
      const remaining = maxChunkTokens - usedTokens
      if (remaining <= 0) break
      const truncated = truncateToApproxTokens(chunkContent, remaining)
      payload[chunkId] = {
        chunkId,
        memoryId,
        documentId: row.documentId,
        chunkIndex: row.chunkIndex,
        content: truncated,
        truncated: true,
      }
      break
    }

    usedTokens += chunkTokens
    payload[chunkId] = {
      chunkId,
      memoryId,
      documentId: row.documentId,
      chunkIndex: row.chunkIndex,
      content: chunkContent,
      truncated: false,
    }
  }

  for (const scored of memories) {
    if (scored.memory.chunkId && payload[scored.memory.chunkId]) continue
    const chunkId = `memory:${scored.memory.id}`
    if (payload[chunkId]) continue
    const fallback = scored.memory.sourceText ?? scored.memory.content
    const chunkTokens = estimateTokens(fallback)
    if (usedTokens + chunkTokens > maxChunkTokens) break
    usedTokens += chunkTokens
    payload[chunkId] = {
      chunkId,
      memoryId: scored.memory.id,
      documentId: scored.memory.documentId,
      chunkIndex: null,
      content: fallback,
      truncated: false,
    }
  }

  return payload
}

function truncateToApproxTokens(text: string, tokenBudget: number): string {
  const maxChars = Math.max(0, tokenBudget * 4)
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}
