/**
 * Consolidation engine — converts raw facts into durable observations.
 *
 * After each retain(), unconsolidated memories (experiences + world facts) are
 * processed one-by-one:
 *   1. Find semantically similar existing observations
 *   2. Single LLM call decides: create new, update existing, or skip
 *   3. Execute actions (create/update observations in memory_units)
 *   4. Mark source memory as consolidated
 *   5. Trigger matching mental model refreshes
 *
 * Observations are stored as memory_units with factType="observation",
 * tracked by proofCount, sourceMemoryIds, and history.
 */

import { chat, streamToText } from "@ellie/ai"
import { ulid } from "@ellie/utils"
import { eq, and, isNull, inArray } from "drizzle-orm"
import * as v from "valibot"
import type { AnyTextAdapter } from "@tanstack/ai"
import type { HindsightDatabase } from "./db"
import type { EmbeddingStore } from "./embedding"
import type {
  ConsolidateOptions,
  ConsolidateResult,
  ConsolidationAction,
  ObservationHistoryEntry,
  RerankFunction,
} from "./types"
import { CONSOLIDATION_SYSTEM, getConsolidationUserPrompt } from "./prompts"
import { parseLLMJson } from "./sanitize"
import { refreshMentalModel } from "./mental-models"

// ── Valibot schema for LLM consolidation response ───────────────────────

const ConsolidationActionSchema = v.array(
  v.union([
    v.object({
      action: v.literal("create"),
      text: v.string(),
      reason: v.string(),
    }),
    v.object({
      action: v.literal("update"),
      observationId: v.string(),
      text: v.string(),
      reason: v.string(),
    }),
  ]),
)

// ── Main consolidation job ──────────────────────────────────────────────

/**
 * Process all unconsolidated memories in a bank, creating/updating observations.
 *
 * This is the core consolidation loop, designed to be called after retain()
 * or on-demand. Only processes memories with factType in ('experience', 'world').
 */
export async function consolidate(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  modelVec: EmbeddingStore,
  adapter: AnyTextAdapter,
  bankId: string,
  options: ConsolidateOptions = {},
  rerank?: RerankFunction,
): Promise<ConsolidateResult> {
  const { schema } = hdb
  const batchSize = options.batchSize ?? 50
  const refreshModels = options.refreshMentalModels ?? true

  const result: ConsolidateResult = {
    memoriesProcessed: 0,
    observationsCreated: 0,
    observationsUpdated: 0,
    mentalModelsRefreshQueued: 0,
  }

  // Fetch unconsolidated memories (experience + world facts only)
  const unconsolidated = hdb.db
    .select()
    .from(schema.memoryUnits)
    .where(
      and(
        eq(schema.memoryUnits.bankId, bankId),
        isNull(schema.memoryUnits.consolidatedAt),
        inArray(schema.memoryUnits.factType, ["experience", "world"]),
      ),
    )
    .limit(batchSize)
    .all()

  if (unconsolidated.length === 0) return result

  // Collect all tags encountered for mental model refresh filtering
  const allTags = new Set<string>()

  for (const memory of unconsolidated) {
    const now = Date.now()

    // Parse memory tags for tracking
    const memoryTags: string[] = memory.tags ? JSON.parse(memory.tags) : []
    for (const tag of memoryTags) allTags.add(tag)

    try {
      // 1. Find related observations via semantic search
      const relatedObs = await findRelatedObservations(
        hdb,
        memoryVec,
        bankId,
        memory.content,
      )

      // 2. Single LLM call to decide actions
      const actions = await consolidateWithLLM(
        adapter,
        memory.content,
        relatedObs,
      )

      // 3. Execute actions
      for (const action of actions) {
        if (action.action === "create") {
          await executeCreateAction(
            hdb,
            memoryVec,
            bankId,
            memory,
            action,
          )
          result.observationsCreated++
        } else if (action.action === "update") {
          await executeUpdateAction(
            hdb,
            memoryVec,
            bankId,
            memory,
            action,
          )
          result.observationsUpdated++
        }
      }

      // 4. Mark memory as consolidated only on success
      hdb.db
        .update(schema.memoryUnits)
        .set({ consolidatedAt: now })
        .where(eq(schema.memoryUnits.id, memory.id))
        .run()

      result.memoriesProcessed++
    } catch {
      // Swallow per-memory errors — don't block the whole batch.
      // Memory is NOT marked consolidated so it will be retried next run.
    }
  }

  // 5. Trigger mental model refreshes
  if (refreshModels) {
    result.mentalModelsRefreshQueued = await triggerMentalModelRefreshes(
      hdb,
      memoryVec,
      modelVec,
      adapter,
      bankId,
      allTags,
      rerank,
    )
  }

  return result
}

// ── Find related observations ───────────────────────────────────────────

interface RelatedObservation {
  id: string
  content: string
  proofCount: number
  sourceCount: number
}

async function findRelatedObservations(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  content: string,
  limit: number = 5,
): Promise<RelatedObservation[]> {
  const hits = await memoryVec.search(content, limit * 2)
  const observations: RelatedObservation[] = []

  for (const hit of hits) {
    if (observations.length >= limit) break

    const similarity = 1 - hit.distance
    if (similarity < 0.5) continue // low threshold — LLM decides relevance

    const row = hdb.db
      .select()
      .from(hdb.schema.memoryUnits)
      .where(
        and(
          eq(hdb.schema.memoryUnits.id, hit.id),
          eq(hdb.schema.memoryUnits.bankId, bankId),
          eq(hdb.schema.memoryUnits.factType, "observation"),
        ),
      )
      .get()

    if (!row) continue

    const sourceMemoryIds: string[] = row.sourceMemoryIds
      ? JSON.parse(row.sourceMemoryIds)
      : []

    observations.push({
      id: row.id,
      content: row.content,
      proofCount: row.proofCount,
      sourceCount: sourceMemoryIds.length,
    })
  }

  return observations
}

// ── LLM consolidation call ──────────────────────────────────────────────

async function consolidateWithLLM(
  adapter: AnyTextAdapter,
  factContent: string,
  relatedObservations: RelatedObservation[],
): Promise<ConsolidationAction[]> {
  const userPrompt = getConsolidationUserPrompt(factContent, relatedObservations)

  try {
    const text = await streamToText(
      chat({
        adapter,
        messages: [{ role: "user", content: userPrompt }],
        systemPrompts: [CONSOLIDATION_SYSTEM],
      }),
    )

    const parsed = parseLLMJson(text, [])
    const validated = v.safeParse(ConsolidationActionSchema, parsed)
    return validated.success ? validated.output : []
  } catch {
    return []
  }
}

// ── Execute create action ───────────────────────────────────────────────

async function executeCreateAction(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  sourceMemory: typeof import("./schema").memoryUnits.$inferSelect,
  action: Extract<ConsolidationAction, { action: "create" }>,
): Promise<void> {
  const { schema } = hdb
  const now = Date.now()
  const obsId = ulid()

  // Inherit tags from source memory
  const tags = sourceMemory.tags

  hdb.db
    .insert(schema.memoryUnits)
    .values({
      id: obsId,
      bankId,
      content: action.text,
      factType: "observation",
      confidence: 1.0,
      validFrom: sourceMemory.validFrom,
      validTo: sourceMemory.validTo,
      mentionedAt: sourceMemory.mentionedAt,
      tags,
      proofCount: 1,
      sourceMemoryIds: JSON.stringify([sourceMemory.id]),
      history: JSON.stringify([]),
      createdAt: now,
      updatedAt: now,
    })
    .run()

  // FTS5 index
  hdb.sqlite.run(
    "INSERT INTO hs_memory_fts (id, bank_id, content) VALUES (?, ?, ?)",
    [obsId, bankId, action.text],
  )

  // Embedding for semantic search
  await memoryVec.upsert(obsId, action.text)
}

// ── Execute update action ───────────────────────────────────────────────

async function executeUpdateAction(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  sourceMemory: typeof import("./schema").memoryUnits.$inferSelect,
  action: Extract<ConsolidationAction, { action: "update" }>,
): Promise<void> {
  const { schema } = hdb
  const now = Date.now()

  // Fetch existing observation
  const existing = hdb.db
    .select()
    .from(schema.memoryUnits)
    .where(
      and(
        eq(schema.memoryUnits.id, action.observationId),
        eq(schema.memoryUnits.bankId, bankId),
        eq(schema.memoryUnits.factType, "observation"),
      ),
    )
    .get()

  if (!existing) return

  // Build history entry
  const history: ObservationHistoryEntry[] = existing.history
    ? JSON.parse(existing.history)
    : []

  history.push({
    previousText: existing.content,
    changedAt: now,
    reason: action.reason,
    sourceMemoryId: sourceMemory.id,
  })

  // Merge source memory IDs
  const existingSourceIds: string[] = existing.sourceMemoryIds
    ? JSON.parse(existing.sourceMemoryIds)
    : []
  if (!existingSourceIds.includes(sourceMemory.id)) {
    existingSourceIds.push(sourceMemory.id)
  }

  // Merge tags (union of existing + source)
  const existingTags: string[] = existing.tags ? JSON.parse(existing.tags) : []
  const sourceTags: string[] = sourceMemory.tags
    ? JSON.parse(sourceMemory.tags)
    : []
  const mergedTags = [...new Set([...existingTags, ...sourceTags])]

  // Expand temporal range
  const validFrom = minNullable(existing.validFrom, sourceMemory.validFrom)
  const validTo = maxNullable(existing.validTo, sourceMemory.validTo)
  const mentionedAt = maxNullable(
    existing.mentionedAt,
    sourceMemory.mentionedAt,
  )

  hdb.db
    .update(schema.memoryUnits)
    .set({
      content: action.text,
      proofCount: existingSourceIds.length,
      sourceMemoryIds: JSON.stringify(existingSourceIds),
      history: JSON.stringify(history),
      tags: mergedTags.length > 0 ? JSON.stringify(mergedTags) : null,
      validFrom,
      validTo,
      mentionedAt,
      updatedAt: now,
    })
    .where(eq(schema.memoryUnits.id, action.observationId))
    .run()

  // Update FTS5 index
  hdb.sqlite.run("DELETE FROM hs_memory_fts WHERE id = ?", [
    action.observationId,
  ])
  hdb.sqlite.run(
    "INSERT INTO hs_memory_fts (id, bank_id, content) VALUES (?, ?, ?)",
    [action.observationId, bankId, action.text],
  )

  // Re-embed with new content
  await memoryVec.upsert(action.observationId, action.text)
}

// ── Mental model refresh trigger ────────────────────────────────────────

async function triggerMentalModelRefreshes(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  modelVec: EmbeddingStore,
  adapter: AnyTextAdapter,
  bankId: string,
  consolidatedTags: Set<string>,
  rerank?: RerankFunction,
): Promise<number> {
  const { schema } = hdb

  // Find auto-refresh mental models in this bank
  const autoRefreshModels = hdb.db
    .select()
    .from(schema.mentalModels)
    .where(
      and(
        eq(schema.mentalModels.bankId, bankId),
        eq(schema.mentalModels.autoRefresh, 1),
      ),
    )
    .all()

  let refreshed = 0

  for (const model of autoRefreshModels) {
    // Tag-based filtering: only refresh if tags overlap or model has no tags
    const modelTags: string[] = model.tags ? JSON.parse(model.tags) : []
    if (modelTags.length > 0 && consolidatedTags.size > 0) {
      const hasOverlap = modelTags.some((t) => consolidatedTags.has(t))
      if (!hasOverlap) continue
    }

    // Fire-and-forget refresh
    refreshMentalModel(hdb, memoryVec, modelVec, adapter, bankId, model.id, rerank)
      .then(() => {})
      .catch(() => {})
    refreshed++
  }

  return refreshed
}

// ── Helpers ─────────────────────────────────────────────────────────────

function minNullable(
  a: number | null,
  b: number | null,
): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.min(a, b)
}

function maxNullable(
  a: number | null,
  b: number | null,
): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.max(a, b)
}
