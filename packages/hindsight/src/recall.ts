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
  RecallTrace,
  RecallTraceCandidate,
  RecallTraceMethodResult,
  RecallTraceMetric,
} from "./types"
import type { RetrievalHit } from "./retrieval/semantic"
import { searchSemantic } from "./retrieval/semantic"
import { searchFulltext } from "./retrieval/fulltext"
import { searchGraph } from "./retrieval/graph"
import { searchTemporal } from "./retrieval/temporal"
import { reciprocalRankFusion } from "./fusion"
import { rowToMemoryUnit, rowToEntity } from "./retain"
import { extractTemporalRange } from "./temporal"

interface TimedHits {
  hits: RetrievalHit[]
  durationMs: number
}

interface RankedCandidate extends RecallTraceCandidate {
  rawCrossEncoderScore: number
}

/**
 * Multi-strategy retrieval with combined scoring parity:
 * combined = 0.6 * crossEncoder + 0.2 * normalizedRrf + 0.1 * temporal + 0.1 * recency
 */
export async function recall(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  query: string,
  options: RecallOptions = {},
  rerank?: RerankFunction,
): Promise<RecallResult> {
  const startedAt = Date.now()
  const phaseMetrics: RecallTraceMetric[] = []
  const limit = options.limit ?? 10
  const maxTokens = options.maxTokens
  const methods = options.methods ?? [
    "semantic",
    "fulltext",
    "graph",
    "temporal",
  ]
  const methodSet = new Set(methods)
  const candidateLimit = Math.max(limit * 4, 20)
  const timeRange = options.timeRange ?? extractTemporalRange(query)

  const retrievalStart = Date.now()
  const semanticTask = methodSet.has("semantic")
    ? timedAsync(() =>
        searchSemantic(hdb, memoryVec, bankId, query, candidateLimit),
      )
    : Promise.resolve<TimedHits>({ hits: [], durationMs: 0 })
  const fulltextTask = methodSet.has("fulltext")
    ? Promise.resolve(
        timedSync(() =>
          searchFulltext(
            hdb,
            bankId,
            query,
            candidateLimit,
            options.tags,
            options.tagsMatch,
          ),
        ),
      )
    : Promise.resolve<TimedHits>({ hits: [], durationMs: 0 })
  const temporalTask = methodSet.has("temporal")
    ? Promise.resolve(
        timedSync(() =>
          searchTemporal(
            hdb,
            bankId,
            timeRange,
            candidateLimit,
            options.tags,
            options.tagsMatch,
          ),
        ),
      )
    : Promise.resolve<TimedHits>({ hits: [], durationMs: 0 })

  const [semanticTimed, fulltextTimed, temporalTimed] = await Promise.all([
    semanticTask,
    fulltextTask,
    temporalTask,
  ])

  const graphTimed = methodSet.has("graph")
    ? await timedAsync(() =>
        searchGraph(hdb, memoryVec, bankId, query, candidateLimit, {
          factTypes: options.factTypes,
          tags: options.tags,
          tagsMatch: options.tagsMatch,
          temporalSeedMemoryIds: temporalTimed.hits.map((hit) => hit.id),
        }),
      )
    : { hits: [], durationMs: 0 }

  phaseMetrics.push({
    phaseName: "parallel_retrieval",
    durationMs: Date.now() - retrievalStart,
    details: {
      semanticCount: semanticTimed.hits.length,
      fulltextCount: fulltextTimed.hits.length,
      graphCount: graphTimed.hits.length,
      temporalCount: temporalTimed.hits.length,
    },
  })

  const resultSets: RetrievalHit[][] = []
  if (methodSet.has("semantic")) resultSets.push(semanticTimed.hits)
  if (methodSet.has("fulltext")) resultSets.push(fulltextTimed.hits)
  if (methodSet.has("graph")) resultSets.push(graphTimed.hits)
  if (methodSet.has("temporal")) resultSets.push(temporalTimed.hits)

  const mergeStart = Date.now()
  const fused = reciprocalRankFusion(resultSets, candidateLimit)
  phaseMetrics.push({
    phaseName: "rrf_merge",
    durationMs: Date.now() - mergeStart,
    details: { candidatesMerged: fused.length },
  })

  if (fused.length === 0) {
    return {
      memories: [],
      query,
      entities: options.includeEntities ? {} : undefined,
      chunks: options.includeChunks ? {} : undefined,
      trace: options.enableTrace
        ? {
            startedAt,
            query,
            maxTokens: maxTokens ?? null,
            temporalConstraint: timeRange,
            retrieval: buildMethodTrace([
              ["semantic", semanticTimed],
              ["fulltext", fulltextTimed],
              ["graph", graphTimed],
              ["temporal", temporalTimed],
            ]),
            phaseMetrics,
            candidates: [],
            selectedMemoryIds: [],
            totalDurationMs: Date.now() - startedAt,
          }
        : undefined,
    }
  }

  const fusedIds = fused.map((candidate) => candidate.id)
  const memoryRows = hdb.db
    .select()
    .from(hdb.schema.memoryUnits)
    .where(inArray(hdb.schema.memoryUnits.id, fusedIds))
    .all()
  const memoryRowById = new Map(memoryRows.map((row) => [row.id, row]))

  const rerankStart = Date.now()
  const rrfMin = Math.min(...fused.map((candidate) => candidate.score))
  const rrfMax = Math.max(...fused.map((candidate) => candidate.score))
  const rrfRange = rrfMax - rrfMin

  let crossEncoderRawScores = fused.map((candidate) => candidate.score)
  let crossEncoderNormalizedScores = fused.map((candidate) =>
    normalizeRrf(candidate.score, rrfMin, rrfRange),
  )
  if (rerank) {
    const candidatesWithContent = fused.filter((candidate) => {
      const row = memoryRowById.get(candidate.id)
      return typeof row?.content === "string" && row.content.length > 0
    })
    if (candidatesWithContent.length > 0) {
      const docs = candidatesWithContent.map(
        (candidate) => memoryRowById.get(candidate.id)!.content,
      )
      const scores = await rerank(query, docs)
      if (scores.length !== candidatesWithContent.length) {
        throw new Error(
          `Rerank score count mismatch: expected ${candidatesWithContent.length}, got ${scores.length}`,
        )
      }
      const scoreById = new Map<string, number>()
      for (let i = 0; i < candidatesWithContent.length; i++) {
        scoreById.set(candidatesWithContent[i]!.id, scores[i]!)
      }
      crossEncoderRawScores = fused.map((candidate) => scoreById.get(candidate.id) ?? 0)
      crossEncoderNormalizedScores = crossEncoderRawScores.map(sigmoid)
    }
  }

  const temporalById = new Map(temporalTimed.hits.map((hit) => [hit.id, hit.score]))
  const now = Date.now()
  const rankedCandidates: RankedCandidate[] = fused
    .map((candidate, index) => {
      const row = memoryRowById.get(candidate.id)
      if (!row) return null

      const rrfNormalized = normalizeRrf(candidate.score, rrfMin, rrfRange)
      const temporal = temporalById.get(candidate.id) ?? 0.5
      const recency = computeRecency(row, now)
      const crossEncoderScoreNormalized = crossEncoderNormalizedScores[index] ?? 0.5
      const combinedScore =
        0.6 * crossEncoderScoreNormalized +
        0.2 * rrfNormalized +
        0.1 * temporal +
        0.1 * recency

      return {
        id: candidate.id,
        rank: 0,
        sources: candidate.sources as RankedCandidate["sources"],
        rrfScore: candidate.score,
        rawCrossEncoderScore: crossEncoderRawScores[index] ?? 0,
        crossEncoderScoreNormalized,
        rrfNormalized,
        temporal,
        recency,
        combinedScore,
      } satisfies RankedCandidate
    })
    .filter((candidate): candidate is RankedCandidate => candidate != null)
    .sort((a, b) => b.combinedScore - a.combinedScore)

  rankedCandidates.forEach((candidate, index) => {
    candidate.rank = index + 1
  })
  phaseMetrics.push({
    phaseName: "combined_scoring",
    durationMs: Date.now() - rerankStart,
    details: {
      candidatesScored: rankedCandidates.length,
      withReranker: Boolean(rerank),
      weights: {
        crossEncoder: 0.6,
        rrf: 0.2,
        temporal: 0.1,
        recency: 0.1,
      },
    },
  })

  const hydrationStart = Date.now()
  const memories: ScoredMemory[] = []
  const entityStates = new Map<string, {
    id: string
    name: string
    entityType: ScoredMemory["entities"][number]["entityType"]
    memoryIds: Set<string>
  }>()
  let usedTokens = 0

  for (const candidate of rankedCandidates) {
    if (memories.length >= limit) break

    const row = memoryRowById.get(candidate.id)
    if (!row) continue

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

    if (options.tags && options.tags.length > 0) {
      const memoryTags = parseStringArray(row.tags)
      if (!matchesTags(memoryTags, options.tags, options.tagsMatch ?? "any")) {
        continue
      }
    }

    const junctions = hdb.db
      .select()
      .from(hdb.schema.memoryEntities)
      .where(eq(hdb.schema.memoryEntities.memoryId, candidate.id))
      .all()

    const entityRows = junctions
      .map((junction) =>
        hdb.db
          .select()
          .from(hdb.schema.entities)
          .where(eq(hdb.schema.entities.id, junction.entityId))
          .get(),
      )
      .filter(Boolean)

    if (options.entities && options.entities.length > 0) {
      const entityNames = new Set(entityRows.map((entityRow) => entityRow!.name.toLowerCase()))
      const hasMatch = options.entities.some((name) => entityNames.has(name.toLowerCase()))
      if (!hasMatch) continue
    }

    if (maxTokens != null) {
      const contentTokens = estimateTokens(row.content)
      if (usedTokens + contentTokens > maxTokens) break
      usedTokens += contentTokens
    }

    memories.push({
      memory: rowToMemoryUnit(row),
      score: candidate.combinedScore,
      sources: candidate.sources,
      entities: entityRows.map((entityRow) => rowToEntity(entityRow!)),
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

  phaseMetrics.push({
    phaseName: "hydrate_filter",
    durationMs: Date.now() - hydrationStart,
    details: {
      selected: memories.length,
      tokenBudget: maxTokens ?? null,
      usedTokens: maxTokens != null ? usedTokens : undefined,
    },
  })

  const entities = options.includeEntities
    ? buildEntityPayload(entityStates, options.maxEntityTokens)
    : undefined
  const chunks = options.includeChunks
    ? buildChunkPayload(hdb, memories, options.maxChunkTokens)
    : undefined

  const trace: RecallTrace | undefined = options.enableTrace
    ? {
        startedAt,
        query,
        maxTokens: maxTokens ?? null,
        temporalConstraint: timeRange,
        retrieval: buildMethodTrace([
          ["semantic", semanticTimed],
          ["fulltext", fulltextTimed],
          ["graph", graphTimed],
          ["temporal", temporalTimed],
        ]),
        phaseMetrics,
        candidates: rankedCandidates,
        selectedMemoryIds: memories.map((memory) => memory.memory.id),
        totalDurationMs: Date.now() - startedAt,
      }
    : undefined

  return { memories, query, entities, chunks, trace }
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
      return isUntagged || memoryTags.some((tag) => filterTags.includes(tag))
    case "all":
      return isUntagged || filterTags.every((tag) => memoryTags.includes(tag))
    case "any_strict":
      return !isUntagged && memoryTags.some((tag) => filterTags.includes(tag))
    case "all_strict":
      return !isUntagged && filterTags.every((tag) => memoryTags.includes(tag))
  }
}

function timedSync(fn: () => RetrievalHit[]): TimedHits {
  const startedAt = Date.now()
  const hits = fn()
  return { hits, durationMs: Date.now() - startedAt }
}

async function timedAsync(fn: () => Promise<RetrievalHit[]>): Promise<TimedHits> {
  const startedAt = Date.now()
  const hits = await fn()
  return { hits, durationMs: Date.now() - startedAt }
}

function buildMethodTrace(
  methods: Array<[RecallTraceMethodResult["methodName"], TimedHits]>,
): RecallTraceMethodResult[] {
  return methods
    .filter(([, timed]) => timed.durationMs > 0 || timed.hits.length > 0)
    .map(([methodName, timed]) => ({
      methodName,
      durationMs: timed.durationMs,
      count: timed.hits.length,
      results: timed.hits.map((hit, index) => ({
        id: hit.id,
        rank: index + 1,
        score: hit.score,
      })),
    }))
}

function normalizeRrf(score: number, min: number, range: number): number {
  if (range <= 0) return 0.5
  return clamp((score - min) / range, 0, 1)
}

function sigmoid(score: number): number {
  return 1 / (1 + Math.exp(-score))
}

function computeRecency(
  row: typeof import("./schema").memoryUnits.$inferSelect,
  now: number,
): number {
  const anchor = row.validFrom ?? row.mentionedAt ?? row.createdAt
  if (anchor == null) return 0.5
  const daysAgo = (now - anchor) / (1000 * 60 * 60 * 24)
  return clamp(Math.max(0.1, 1 - daysAgo / 365), 0.1, 1)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === "string")
  } catch {
    return []
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
