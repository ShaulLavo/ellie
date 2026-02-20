/**
 * Agentic reflection over memories with 3-tier hierarchical retrieval.
 *
 * Tier 1 — Mental Models: user-curated summaries with staleness signals
 * Tier 2 — Observations: auto-consolidated durable knowledge with freshness
 * Tier 3 — Raw Facts: individual experiences + world knowledge (ground truth)
 * Utility — get_entity: cross-tier entity lookup
 *
 * The LLM decides when to drill down between tiers based on staleness metadata.
 * A budget parameter controls exploration depth (low/mid/high → 3/5/8 iterations).
 */

import { chat, streamToText, maxIterations, toolDefinition } from "@ellie/ai"
import { ulid } from "@ellie/utils"
import { eq, and } from "drizzle-orm"
import * as v from "valibot"
import type { AnyTextAdapter } from "@tanstack/ai"
import type { HindsightDatabase } from "./db"
import type { EmbeddingStore } from "./embedding"
import type {
  ReflectOptions,
  ReflectResult,
  ReflectBudget,
  Freshness,
  ScoredMemory,
  RerankFunction,
} from "./types"
import { recall } from "./recall"
import { searchMentalModelsWithStaleness } from "./mental-models"
import { loadDirectivesForReflect } from "./directives"
import {
  getReflectSystemPrompt,
  buildDirectivesSection,
  buildDirectivesReminder,
} from "./prompts"

// ── Budget → iterations mapping ─────────────────────────────────────────

const BUDGET_ITERATIONS: Record<ReflectBudget, number> = {
  low: 3,
  mid: 5,
  high: 8,
}

// ── Main reflect function ───────────────────────────────────────────────

/**
 * @param modelVec - Embedding store for mental models. Pass null to skip
 *   mental model lookup (used during refresh to avoid recursion).
 */
export async function reflect(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  modelVec: EmbeddingStore | null,
  adapter: AnyTextAdapter,
  bankId: string,
  query: string,
  options: ReflectOptions = {},
  rerank?: RerankFunction,
): Promise<ReflectResult> {
  const allMemories: ScoredMemory[] = []
  const { schema } = hdb

  const budget = options.budget ?? "mid"
  const iterations = options.maxIterations ?? BUDGET_ITERATIONS[budget]

  // ── Tier 1: search_mental_models ──

  const searchMentalModelsDef = toolDefinition({
    name: "search_mental_models",
    description:
      "Search user-curated mental model summaries. Use FIRST when the question might be covered by an existing mental model. " +
      "If a result has is_stale=true, also search observations or raw facts to verify currency.",
    inputSchema: v.object({
      query: v.pipe(v.string(), v.description("Search query for mental models")),
    }),
  })

  const searchMentalModels = searchMentalModelsDef.server(async (_args) => {
    const args = _args as { query: string }

    if (!modelVec) return []

    return searchMentalModelsWithStaleness(hdb, modelVec, bankId, args.query)
  })

  // ── Tier 2: search_observations ──

  const searchObservationsDef = toolDefinition({
    name: "search_observations",
    description:
      "Search consolidated observations (auto-generated durable knowledge). " +
      "Observations synthesize multiple raw facts — more reliable than individual facts. " +
      "If stale (freshness != 'up_to_date'), ALSO use search_memories to verify with current raw facts.",
    inputSchema: v.object({
      query: v.pipe(v.string(), v.description("Search query for observations")),
      limit: v.optional(v.pipe(v.number(), v.description("Max results (default 10)"))),
      tags: v.optional(v.array(v.string(), "Filter by tags (merged with session-level tags)")),
    }),
  })

  const searchObservations = searchObservationsDef.server(async (_args) => {
    const args = _args as { query: string; limit?: number; tags?: string[] }

    // Merge tool-level tags with session-level tags
    const mergedTags = mergeTags(options.tags, args.tags)

    const result = await recall(hdb, memoryVec, bankId, args.query, {
      limit: args.limit ?? 10,
      factTypes: ["observation"],
      tags: mergedTags,
      tagsMatch: options.tagsMatch,
    }, rerank)

    allMemories.push(...result.memories)

    return result.memories.map((m) => {
      const staleness = computeObservationStaleness(hdb, bankId, m.memory.updatedAt)
      return {
        id: m.memory.id,
        content: m.memory.content,
        proofCount: m.memory.proofCount,
        sourceMemoryIds: m.memory.sourceMemoryIds ?? [],
        tags: m.memory.tags,
        score: m.score,
        ...staleness,
      }
    })
  })

  // ── Tier 3: search_memories (raw facts) ──

  const searchMemoriesDef = toolDefinition({
    name: "search_memories",
    description:
      "Search raw facts (experiences and world knowledge). Ground truth. " +
      "Use when no mental models or observations exist, they are stale, or you need specific details and supporting evidence.",
    inputSchema: v.object({
      query: v.pipe(v.string(), v.description("Search query — be specific and targeted")),
      limit: v.optional(v.pipe(v.number(), v.description("Max results (default 10)"))),
      tags: v.optional(v.array(v.string(), "Filter by tags (merged with session-level tags)")),
    }),
  })

  const searchMemories = searchMemoriesDef.server(async (_args) => {
    const args = _args as { query: string; limit?: number; tags?: string[] }

    // Merge tool-level tags with session-level tags
    const mergedTags = mergeTags(options.tags, args.tags)

    const result = await recall(hdb, memoryVec, bankId, args.query, {
      limit: args.limit ?? 10,
      factTypes: ["experience", "world"],
      tags: mergedTags,
      tagsMatch: options.tagsMatch,
    }, rerank)

    allMemories.push(...result.memories)

    return result.memories.map((m) => ({
      id: m.memory.id,
      content: m.memory.content,
      factType: m.memory.factType,
      entities: m.entities.map((e) => e.name),
      score: m.score,
      occurredAt: m.memory.validFrom ?? m.memory.createdAt,
    }))
  })

  // ── Utility: get_entity ──

  const getEntityDef = toolDefinition({
    name: "get_entity",
    description:
      "Get information about a specific named entity and all associated memories. Works across all tiers.",
    inputSchema: v.object({
      name: v.pipe(v.string(), v.description("Entity name to look up")),
    }),
  })

  const getEntity = getEntityDef.server(async (_args) => {
    const args = _args as { name: string }
    const entity = hdb.db
      .select()
      .from(schema.entities)
      .where(
        and(
          eq(schema.entities.bankId, bankId),
          eq(schema.entities.name, args.name),
        ),
      )
      .get()

    if (!entity) return { found: false as const }

    const junctions = hdb.db
      .select()
      .from(schema.memoryEntities)
      .where(eq(schema.memoryEntities.entityId, entity.id))
      .all()

    const memoryRows = junctions
      .map((j) =>
        hdb.db
          .select()
          .from(schema.memoryUnits)
          .where(eq(schema.memoryUnits.id, j.memoryId))
          .get(),
      )
      .filter(Boolean)

    return {
      found: true as const,
      entity: {
        name: entity.name,
        type: entity.entityType,
        firstSeen: entity.firstSeen,
        lastUpdated: entity.lastUpdated,
      },
      memoryCount: memoryRows.length,
      memories: memoryRows.slice(0, 10).map((m) => ({
        content: m!.content,
        factType: m!.factType,
      })),
    }
  })

  // ── Run the agentic loop ──

  const userMessage = options.context
    ? `${query}\n\nAdditional context: ${options.context}`
    : query

  // Load directives and build system prompt with injection at top + bottom
  const activeDirectives = loadDirectivesForReflect(hdb, bankId, options.tags, options.tagsMatch)
  const basePrompt = getReflectSystemPrompt(budget)
  const systemPrompt =
    buildDirectivesSection(activeDirectives) +
    basePrompt +
    buildDirectivesReminder(activeDirectives)

  const answer = await streamToText(
    chat({
      adapter,
      messages: [{ role: "user", content: userMessage }],
      systemPrompts: [systemPrompt],
      tools: [searchMentalModels, searchObservations, searchMemories, getEntity],
      agentLoopStrategy: maxIterations(iterations),
    }),
  )

  // ── Optionally save as observation (stored as memory_unit with factType="observation") ──

  const observationTexts: string[] = []

  if (options.saveObservations !== false && answer.trim()) {
    const obsId = ulid()
    const now = Date.now()
    const sourceIds = [...new Set(allMemories.map((m) => m.memory.id))]

    hdb.db
      .insert(schema.memoryUnits)
      .values({
        id: obsId,
        bankId,
        content: answer,
        factType: "observation",
        confidence: 1.0,
        proofCount: sourceIds.length,
        sourceMemoryIds: JSON.stringify(sourceIds),
        tags: options.tags ? JSON.stringify(options.tags) : null,
        history: JSON.stringify([]),
        consolidatedAt: now, // mark as already consolidated
        createdAt: now,
        updatedAt: now,
      })
      .run()

    // Index in FTS5 + vector store for future retrieval
    hdb.sqlite.run(
      "INSERT INTO hs_memory_fts (id, bank_id, content) VALUES (?, ?, ?)",
      [obsId, bankId, answer],
    )

    if (memoryVec) {
      await memoryVec.upsert(obsId, answer)
    }

    observationTexts.push(answer)
  }

  // ── Deduplicate collected memories ──

  const seen = new Set<string>()
  const uniqueMemories: ScoredMemory[] = []
  for (const m of allMemories) {
    if (!seen.has(m.memory.id)) {
      seen.add(m.memory.id)
      uniqueMemories.push(m)
    }
  }

  return {
    answer,
    memories: uniqueMemories,
    observations: observationTexts,
  }
}

// ── Staleness helpers ───────────────────────────────────────────────────

interface ObservationStalenessInfo {
  isStale: boolean
  stalenessReason: string | null
  freshness: Freshness
}

/**
 * Compute observation staleness based on pending unconsolidated memories.
 *
 * An observation may be stale if new raw facts have arrived since the observation
 * was last updated but have not yet been processed by consolidation.
 *
 *   0 pending        → up_to_date
 *   1-3 pending      → slightly_stale (isStale=false, LLM sees metadata)
 *   4+ pending       → stale (isStale=true)
 */
function computeObservationStaleness(
  hdb: HindsightDatabase,
  bankId: string,
  observationUpdatedAt: number,
): ObservationStalenessInfo {
  const pendingCount = countPendingConsolidation(hdb, bankId, observationUpdatedAt)

  if (pendingCount === 0) {
    return { isStale: false, stalenessReason: null, freshness: "up_to_date" }
  }

  if (pendingCount <= 3) {
    return {
      isStale: false,
      stalenessReason: `${pendingCount} memories pending consolidation`,
      freshness: "slightly_stale",
    }
  }

  return {
    isStale: true,
    stalenessReason: `${pendingCount} memories pending consolidation`,
    freshness: "stale",
  }
}

/**
 * Count unconsolidated experience+world facts created after a given timestamp.
 */
function countPendingConsolidation(
  hdb: HindsightDatabase,
  bankId: string,
  afterTimestamp: number,
): number {
  const result = hdb.sqlite
    .prepare(
      `SELECT COUNT(*) as cnt FROM hs_memory_units
       WHERE bank_id = ?
       AND consolidated_at IS NULL
       AND fact_type IN ('experience', 'world')
       AND created_at > ?`,
    )
    .get(bankId, afterTimestamp) as { cnt: number }

  return result.cnt
}

/** Merge session-level tags with tool-level tags (union, deduplicated) */
function mergeTags(
  sessionTags?: string[],
  toolTags?: string[],
): string[] | undefined {
  if (!sessionTags?.length && !toolTags?.length) return undefined
  return [...new Set([...(sessionTags ?? []), ...(toolTags ?? [])])]
}
