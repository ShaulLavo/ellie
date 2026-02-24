import { inArray, sql } from "drizzle-orm"
import type { HindsightDatabase } from "./db"
import type { EmbeddingStore } from "./embedding"
import type {
  RecallOptions,
  RecallResult,
  ScoredMemory,
  FactType,
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
import { scoreCognitive, type CognitiveCandidate } from "./retrieval/cognitive"
import type { WorkingMemoryStore } from "./working-memory"
import { reciprocalRankFusion } from "./fusion"
import { rowToMemoryUnit, rowToEntity } from "./retain"
import { extractTemporalRange } from "./temporal"
import { matchesTags, parseStringArray } from "./tags"
import { clamp } from "./util"
import {
  detectLocationSignals,
  resolveSignalsToPaths,
  computeLocationBoost,
  getMaxStrengthForPaths,
} from "./location"
import { packContext, type PackCandidate } from "./context-pack"
import { scopeMatches, resolveScope, type ScopeMode } from "./scope"

/** Extended recall options with Phase 3 scope + tokenBudget support */
interface RecallOptionsWithScope extends RecallOptions {
  tokenBudget?: number
  scope?: { profile?: string; project?: string; session?: string }
  scopeMode?: ScopeMode
}

interface TimedHits {
  hits: RetrievalHit[]
  durationMs: number
}

interface RankedCandidate extends RecallTraceCandidate {
  rawCrossEncoderScore: number
}

/**
 * Multi-strategy retrieval with combined scoring.
 *
 * mode="hybrid" (default):
 *   combined = 0.6 * crossEncoder + 0.2 * normalizedRrf + 0.1 * temporal + 0.1 * recency
 *
 * mode="cognitive":
 *   cognitive_score = 0.50*probe + 0.35*base + 0.15*spread (+ WM boost)
 */
export async function recall(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  query: string,
  options: RecallOptions = {},
  rerank?: RerankFunction,
  workingMemory?: WorkingMemoryStore,
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

  // Batch-load memory rows for all fused candidates (avoids N+1)
  const fusedIds = fused.map((candidate) => candidate.id)
  const memoryRows = hdb.db
    .select()
    .from(hdb.schema.memoryUnits)
    .where(inArray(hdb.schema.memoryUnits.id, fusedIds))
    .all()
  const memoryRowById = new Map(memoryRows.map((row) => [row.id, row]))

  const rerankStart = Date.now()
  const mode = options.mode ?? "hybrid"
  const now = Date.now()

  let rankedCandidates: RankedCandidate[]

  if (mode === "cognitive") {
    // ── Cognitive scoring path ──────────────────────────────────────────
    // Build semantic similarity map from the original retrieval hits
    const semanticScoreById = new Map<string, number>()
    for (const hit of semanticTimed.hits) {
      semanticScoreById.set(hit.id, hit.score)
    }

    // Build cognitive candidates with access metadata from loaded rows
    const cogCandidates: CognitiveCandidate[] = fused
      .map((candidate) => {
        const row = memoryRowById.get(candidate.id)
        if (!row) return null
        return {
          id: candidate.id,
          semanticSimilarity: semanticScoreById.get(candidate.id) ?? 0,
          accessCount: row.accessCount,
          lastAccessed: row.lastAccessed,
          encodingStrength: row.encodingStrength,
        }
      })
      .filter((c): c is CognitiveCandidate => c != null)

    const cogScored = scoreCognitive(hdb, cogCandidates, now)

    // Apply working memory boost if sessionId is provided
    const sessionId = options.sessionId
    const hasWm = workingMemory != null && sessionId != null
    const fusedById = new Map(fused.map((f) => [f.id, f]))

    rankedCandidates = cogScored.map((scored, index) => {
      const wmBoost =
        hasWm
          ? workingMemory.getBoost(bankId, sessionId, scored.id, now)
          : 0
      const finalScore = scored.cognitiveScore + wmBoost
      const candidate = fusedById.get(scored.id)!

      return {
        id: scored.id,
        rank: index + 1,
        sources: candidate.sources as RankedCandidate["sources"],
        rrfScore: candidate.score,
        rawCrossEncoderScore: 0,
        crossEncoderScoreNormalized: 0,
        rrfNormalized: 0,
        temporal: 0,
        recency: 0,
        combinedScore: finalScore,
        probeActivation: scored.probe,
        baseLevelActivation: scored.base,
        spreadingActivation: scored.spread,
        wmBoost,
      } satisfies RankedCandidate
    })

    // Re-sort with WM boost applied, deterministic tie-break by id
    rankedCandidates.sort((a, b) => {
      if (b.combinedScore !== a.combinedScore) {
        return b.combinedScore - a.combinedScore
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    rankedCandidates.forEach((c, i) => { c.rank = i + 1 })

    phaseMetrics.push({
      phaseName: "combined_scoring",
      durationMs: Date.now() - rerankStart,
      details: {
        candidatesScored: rankedCandidates.length,
        mode: "cognitive",
        withWorkingMemory: hasWm,
      },
    })
  } else {
    // ── Hybrid scoring path (unchanged) ─────────────────────────────────
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
    rankedCandidates = fused
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
        mode: "hybrid",
        weights: {
          crossEncoder: 0.6,
          rrf: 0.2,
          temporal: 0.1,
          recency: 0.1,
        },
      },
    })
  }

  // ── Phase 3: Location boost ───────────────────────────────────────────────
  // Only applied when query contains location signals (file paths, module tokens)
  const locationBoostStart = Date.now()
  const locationSignals = detectLocationSignals(query)
  let locationBoostApplied = false

  if (locationSignals.length > 0) {
    const scopeFilter = options.scope
      ? { profile: options.scope.profile, project: options.scope.project }
      : undefined
    const signalPathMap = resolveSignalsToPaths(hdb, bankId, locationSignals, scopeFilter)
    const allQueryPathIds = new Set<string>()
    for (const pathIds of signalPathMap.values()) {
      for (const id of pathIds) allQueryPathIds.add(id)
    }

    if (allQueryPathIds.size > 0) {
      const maxStrength = getMaxStrengthForPaths(hdb, bankId, allQueryPathIds)

      for (const candidate of rankedCandidates) {
        const boost = computeLocationBoost(
          hdb,
          bankId,
          candidate.id,
          allQueryPathIds,
          maxStrength,
          now,
        )
        if (boost > 0) {
          candidate.combinedScore += boost
          locationBoostApplied = true
        }
      }

      if (locationBoostApplied) {
        // Re-sort after boost application
        rankedCandidates.sort((a, b) => {
          if (b.combinedScore !== a.combinedScore) {
            return b.combinedScore - a.combinedScore
          }
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        })
        rankedCandidates.forEach((c, i) => { c.rank = i + 1 })
      }
    }
  }

  phaseMetrics.push({
    phaseName: "location_boost",
    durationMs: Date.now() - locationBoostStart,
    details: {
      signalsDetected: locationSignals.length,
      boostApplied: locationBoostApplied,
    },
  })

  // ── Phase 3: Scope resolution ──────────────────────────────────────────────
  const effectiveScope = options.scope
    ? resolveScope(options.scope)
    : undefined
  const scopeMode: ScopeMode = (options as RecallOptionsWithScope).scopeMode ?? "strict"

  const hydrationStart = Date.now()

  // Batch-load all junctions + entities for ranked candidates (avoids N+1)
  const rankedIds = rankedCandidates.map((c) => c.id)
  const allJunctions =
    rankedIds.length > 0
      ? hdb.db
          .select()
          .from(hdb.schema.memoryEntities)
          .where(inArray(hdb.schema.memoryEntities.memoryId, rankedIds))
          .all()
      : []

  // Group junctions by memoryId
  const junctionsByMemoryId = new Map<string, typeof allJunctions>()
  for (const j of allJunctions) {
    const list = junctionsByMemoryId.get(j.memoryId)
    if (list) list.push(j)
    else junctionsByMemoryId.set(j.memoryId, [j])
  }

  // Batch-load all referenced entities
  const allEntityIds = [...new Set(allJunctions.map((j) => j.entityId))]
  const allEntityRows =
    allEntityIds.length > 0
      ? hdb.db
          .select()
          .from(hdb.schema.entities)
          .where(inArray(hdb.schema.entities.id, allEntityIds))
          .all()
      : []
  const entityById = new Map(allEntityRows.map((e) => [e.id, e]))

  // Hydrate full memory objects with entities, apply filters
  const memories: ScoredMemory[] = []
  const entityStates = new Map<string, {
    id: string
    name: string
    entityType: ScoredMemory["entities"][number]["entityType"]
    memoryIds: Set<string>
  }>()
  let usedTokens = 0

  const VALID_SOURCES = new Set(["semantic", "fulltext", "graph", "temporal"])

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

    // Look up pre-loaded entities for this memory (avoids N+1)
    const junctions = junctionsByMemoryId.get(candidate.id) ?? []
    const entityRows = junctions
      .map((j) => entityById.get(j.entityId))
      .filter(Boolean)

    if (options.entities && options.entities.length > 0) {
      const entityNames = new Set(entityRows.map((entityRow) => entityRow!.name.toLowerCase()))
      const hasMatch = options.entities.some((name) => entityNames.has(name.toLowerCase()))
      if (!hasMatch) continue
    }

    // Phase 3: Scope filtering
    if (effectiveScope) {
      if (
        !scopeMatches(
          { profile: row.scopeProfile, project: row.scopeProject },
          effectiveScope,
          scopeMode,
        )
      ) {
        continue
      }
    }

    if (maxTokens != null && !options.tokenBudget) {
      const contentTokens = estimateTokens(row.content)
      if (usedTokens + contentTokens > maxTokens) break
      usedTokens += contentTokens
    }

    // Validate sources at runtime — filter to known retrieval methods
    const validatedSources = candidate.sources.filter((s) =>
      VALID_SOURCES.has(s),
    ) as ScoredMemory["sources"]

    memories.push({
      memory: rowToMemoryUnit(row),
      score: candidate.combinedScore,
      sources: validatedSources,
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

  // ── Phase 3: Token budget packing ──────────────────────────────────────────
  // When tokenBudget is specified, apply the gist-first context packing policy
  const tokenBudget = (options as RecallOptionsWithScope).tokenBudget
  if (tokenBudget != null && tokenBudget > 0 && memories.length > 0) {
    const packStart = Date.now()
    const packCandidates: PackCandidate[] = memories.map((m) => ({
      id: m.memory.id,
      content: m.memory.content,
      gist: memoryRowById.get(m.memory.id)?.gist ?? null,
      score: m.score,
    }))

    const packResult = packContext(packCandidates, tokenBudget)

    // Replace memory content with packed versions where applicable
    const packedMemories: ScoredMemory[] = []
    for (const pm of packResult.packed) {
      const original = memories.find((m) => m.memory.id === pm.id)
      if (!original) continue
      if (pm.mode === "gist") {
        // Replace content with gist text for downstream consumers
        packedMemories.push({
          ...original,
          memory: { ...original.memory, content: pm.text },
        })
      } else {
        packedMemories.push(original)
      }
    }

    // Replace memories array with packed version
    memories.length = 0
    memories.push(...packedMemories)

    phaseMetrics.push({
      phaseName: "context_pack",
      durationMs: Date.now() - packStart,
      details: {
        tokenBudget,
        totalTokensUsed: packResult.totalTokensUsed,
        budgetRemaining: packResult.budgetRemaining,
        overflow: packResult.overflow,
        packedCount: packResult.packed.length,
        gistCount: packResult.packed.filter((p) => p.mode === "gist").length,
        fullCount: packResult.packed.filter((p) => p.mode === "full").length,
      },
    })
  }

  // ── Access write-through (both modes) ────────────────────────────────────
  // For returned memories only: increment access_count, update last_accessed,
  // bump encoding_strength (capped at 3.0). Executed synchronously before return.
  const returnedIds = memories.map((m) => m.memory.id)
  if (returnedIds.length > 0) {
    updateAccessMetadata(hdb, returnedIds, now)
  }

  // ── Working memory touch (cognitive mode only) ──────────────────────────
  if (
    mode === "cognitive" &&
    workingMemory != null &&
    options.sessionId != null &&
    returnedIds.length > 0
  ) {
    workingMemory.touch(bankId, options.sessionId, returnedIds, now)
  }

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

// Re-export matchesTags for downstream consumers
export { matchesTags } from "./tags"

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
  let anchor: number | null = null
  const occurredStart = row.occurredStart
  const occurredEnd = row.occurredEnd
  if (occurredStart != null && occurredEnd != null) {
    anchor = Math.round((occurredStart + occurredEnd) / 2)
  } else {
    anchor =
      occurredStart ??
      occurredEnd ??
      row.mentionedAt ??
      row.eventDate ??
      row.createdAt
  }
  if (anchor == null) return 0.5
  const daysAgo = (now - anchor) / (1000 * 60 * 60 * 24)
  return clamp(Math.max(0.1, 1 - daysAgo / 365), 0.1, 1)
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

/**
 * Batch-update access metadata for returned memory IDs.
 *
 * For each returned ID:
 * - access_count = access_count + 1
 * - last_accessed = now
 * - encoding_strength = MIN(3.0, encoding_strength + 0.02)
 */
function updateAccessMetadata(
  hdb: HindsightDatabase,
  memoryIds: string[],
  now: number,
): void {
  if (memoryIds.length === 0) return

  const mu = hdb.schema.memoryUnits
  hdb.db
    .update(mu)
    .set({
      accessCount: sql`${mu.accessCount} + 1`,
      lastAccessed: now,
      encodingStrength: sql`MIN(3.0, ${mu.encodingStrength} + 0.02)`,
    })
    .where(inArray(mu.id, memoryIds))
    .run()
}
