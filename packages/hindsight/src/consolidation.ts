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
  TagsMatch,
} from "./types"
import { matchesTags } from "./recall"
import { CONSOLIDATION_SYSTEM, getConsolidationUserPrompt } from "./prompts"
import { parseLLMJson } from "./sanitize"
import { refreshMentalModel } from "./mental-models"
import type { BankProfile } from "./reflect"

// ── Helpers ──────────────────────────────────────────────────────────────

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

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
    v.object({
      action: v.literal("merge"),
      observationIds: v.array(v.string()),
      text: v.string(),
      reason: v.string(),
    }),
    v.object({
      action: v.literal("skip"),
      reason: v.optional(v.string()),
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
  bankProfile?: BankProfile,
): Promise<ConsolidateResult> {
  const { schema } = hdb
  const batchSize = options.batchSize ?? 50
  const refreshModels = options.refreshMentalModels ?? true

  const result: ConsolidateResult = {
    memoriesProcessed: 0,
    observationsCreated: 0,
    observationsUpdated: 0,
    observationsMerged: 0,
    skipped: 0,
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

    // Parse memory tags for tracking (safe fallback on corrupt data)
    let memoryTags: string[] = []
    try {
      memoryTags = memory.tags ? JSON.parse(memory.tags) : []
    } catch {
      // malformed JSON → treat as untagged
    }
    for (const tag of memoryTags) allTags.add(tag)

    try {
      // 1. Find related observations via semantic search
      // SECURITY: Pass memory tags for all_strict filtering to prevent cross-tenant leakage
      const relatedObs = await findRelatedObservations(
        hdb,
        memoryVec,
        bankId,
        memory.content,
        memoryTags.length > 0 ? memoryTags : undefined,
      )

      // 2. Single LLM call to decide actions
      const actions = await consolidateWithLLM(
        adapter,
        memory.content,
        relatedObs,
      )

      if (actions.length === 0) {
        result.skipped++
      }

      // 3. Execute actions
      for (const action of actions) {
        if (action.action === "skip") {
          result.skipped++
          continue
        }

        if (action.action === "create") {
          const createResult = await executeCreateAction(
            hdb,
            memoryVec,
            bankId,
            memory,
            action,
          )
          if (createResult === "skipped") {
            result.skipped++
            continue
          }
          result.observationsCreated++
          continue
        }

        if (action.action === "update") {
          const updateResult = await executeUpdateAction(
            hdb,
            memoryVec,
            bankId,
            memory,
            action,
          )
          if (updateResult === "skipped") {
            result.skipped++
            continue
          }
          result.observationsUpdated++
          continue
        }

        const mergeResult = await executeMergeAction(
          hdb,
          memoryVec,
          bankId,
          memory,
          action,
        )
        if (mergeResult === "skipped") {
          result.skipped++
          continue
        }
        result.observationsMerged++
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
      bankProfile,
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

/**
 * Find related observations via semantic search.
 *
 * SECURITY: When `tags` is provided, uses `all_strict` matching to prevent
 * cross-tenant/cross-user information leakage. Observations are only found
 * within the same tag scope as the source memory being consolidated.
 */
async function findRelatedObservations(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  content: string,
  tags?: string[],
  limit: number = 5,
): Promise<RelatedObservation[]> {
  const hits = await memoryVec.search(content, limit * 2)
  const observations: RelatedObservation[] = []

  // SECURITY: Use all_strict matching if tags provided to prevent cross-scope consolidation
  const tagsMatch: TagsMatch = tags?.length ? "all_strict" : "any"

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

    // SECURITY: Filter by tags to prevent cross-tenant observation leakage
    if (tags?.length) {
      const obsTags: string[] = row.tags ? JSON.parse(row.tags) : []
      if (!matchesTags(obsTags, tags, tagsMatch)) continue
    }

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
    const normalized = normalizeConsolidationActions(parsed)
    const validated = v.safeParse(ConsolidationActionSchema, normalized)
    return validated.success ? validated.output : []
  } catch {
    return []
  }
}

function normalizeConsolidationActions(raw: unknown): ConsolidationAction[] {
  if (!Array.isArray(raw)) return []

  const actions: ConsolidationAction[] = []
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") continue
    const record = candidate as Record<string, unknown>
    const action = asString(record.action)
    if (!action) continue

    if (action === "skip") {
      actions.push({
        action: "skip",
        reason: asString(record.reason),
      })
      continue
    }

    const text = asString(record.text)
    if (!text) continue
    const reason = asString(record.reason) ?? ""

    if (action === "create") {
      actions.push({ action: "create", text, reason })
      continue
    }

    if (action === "update") {
      const observationId = asString(record.observationId ?? record.learning_id)
      if (!observationId) continue
      actions.push({
        action: "update",
        observationId,
        text,
        reason,
      })
      continue
    }

    if (action === "merge") {
      const observationIds = asStringArray(
        record.observationIds ?? record.learning_ids ?? record.observation_ids,
      )
      if (observationIds.length < 2) continue
      actions.push({
        action: "merge",
        observationIds,
        text,
        reason,
      })
    }
  }

  return actions
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item))
}

// ── Execute create action ───────────────────────────────────────────────

async function executeCreateAction(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  sourceMemory: typeof import("./schema").memoryUnits.$inferSelect,
  action: Extract<ConsolidationAction, { action: "create" }>,
): Promise<"created" | "skipped"> {
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
      confidence: sourceMemory.confidence,
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
  return "created"
}

// ── Execute update action ───────────────────────────────────────────────

async function executeUpdateAction(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  sourceMemory: typeof import("./schema").memoryUnits.$inferSelect,
  action: Extract<ConsolidationAction, { action: "update" }>,
): Promise<"updated" | "skipped"> {
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

  if (!existing) return "skipped"

  // Build history entry (safe parse in case of corrupt data)
  const history: ObservationHistoryEntry[] = safeJsonParse(existing.history, [])

  history.push({
    previousText: existing.content,
    changedAt: now,
    reason: action.reason,
    sourceMemoryId: sourceMemory.id,
  })

  // Merge source memory IDs (safe parse)
  const existingSourceIds: string[] = safeJsonParse(existing.sourceMemoryIds, [])
  if (!existingSourceIds.includes(sourceMemory.id)) {
    existingSourceIds.push(sourceMemory.id)
  }

  // Merge tags (union of existing + source, safe parse)
  const existingTags: string[] = safeJsonParse(existing.tags, [])
  const sourceTags: string[] = safeJsonParse(sourceMemory.tags, [])
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
  return "updated"
}

async function executeMergeAction(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  sourceMemory: typeof import("./schema").memoryUnits.$inferSelect,
  action: Extract<ConsolidationAction, { action: "merge" }>,
): Promise<"merged" | "skipped"> {
  const { schema } = hdb
  const now = Date.now()
  const observationIds = [...new Set(action.observationIds)]
  if (observationIds.length < 2) return "skipped"

  const observations = hdb.db
    .select()
    .from(schema.memoryUnits)
    .where(
      and(
        eq(schema.memoryUnits.bankId, bankId),
        eq(schema.memoryUnits.factType, "observation"),
        inArray(schema.memoryUnits.id, observationIds),
      ),
    )
    .all()
  if (observations.length < 2) return "skipped"

  const targetId = observationIds.find((id) =>
    observations.some((observation) => observation.id === id),
  )
  if (!targetId) return "skipped"

  const target = observations.find((observation) => observation.id === targetId)
  if (!target) return "skipped"

  const mergedAway = observations.filter((observation) => observation.id !== targetId)
  if (mergedAway.length === 0) return "skipped"

  const sourceMemoryIds = new Set<string>([sourceMemory.id])
  for (const observation of observations) {
    const ids = parseStringArrayJson(observation.sourceMemoryIds)
    for (const id of ids) sourceMemoryIds.add(id)
  }

  const mergedTags = new Set<string>(parseStringArrayJson(sourceMemory.tags))
  for (const observation of observations) {
    const tags = parseStringArrayJson(observation.tags)
    for (const tag of tags) mergedTags.add(tag)
  }

  const history = mergeObservationHistories(
    observations,
    now,
    action.reason,
    sourceMemory.id,
  )

  let validFrom = sourceMemory.validFrom
  let validTo = sourceMemory.validTo
  let mentionedAt = sourceMemory.mentionedAt
  for (const observation of observations) {
    validFrom = minNullable(validFrom, observation.validFrom)
    validTo = maxNullable(validTo, observation.validTo)
    mentionedAt = maxNullable(mentionedAt, observation.mentionedAt)
  }

  hdb.db
    .update(schema.memoryUnits)
    .set({
      content: action.text,
      proofCount: sourceMemoryIds.size,
      sourceMemoryIds: JSON.stringify([...sourceMemoryIds]),
      history: JSON.stringify(history),
      tags:
        mergedTags.size > 0 ? JSON.stringify([...mergedTags]) : null,
      validFrom,
      validTo,
      mentionedAt,
      updatedAt: now,
    })
    .where(eq(schema.memoryUnits.id, targetId))
    .run()

  hdb.sqlite.run("DELETE FROM hs_memory_fts WHERE id = ?", [targetId])
  hdb.sqlite.run(
    "INSERT INTO hs_memory_fts (id, bank_id, content) VALUES (?, ?, ?)",
    [targetId, bankId, action.text],
  )

  for (const observation of mergedAway) {
    hdb.db
      .delete(schema.memoryUnits)
      .where(eq(schema.memoryUnits.id, observation.id))
      .run()
    hdb.sqlite.run("DELETE FROM hs_memory_fts WHERE id = ?", [observation.id])
    memoryVec.delete(observation.id)
  }

  await memoryVec.upsert(targetId, action.text)
  return "merged"
}

// ── Mental model refresh trigger ────────────────────────────────────────

/**
 * Trigger refreshes for auto-refresh mental models after consolidation.
 *
 * SECURITY: Controls which mental models get refreshed based on tag boundaries
 * to prevent cross-tenant information leakage:
 *
 * - If tagged memories were consolidated: refresh mental models with overlapping
 *   tags OR untagged mental models (they're "global" and available to all contexts).
 *   DO NOT refresh mental models with different tags.
 *
 * - If only untagged memories were consolidated: only refresh untagged mental models.
 *   Tagged mental models are NOT refreshed when untagged memories are consolidated.
 */
async function triggerMentalModelRefreshes(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  modelVec: EmbeddingStore,
  adapter: AnyTextAdapter,
  bankId: string,
  consolidatedTags: Set<string>,
  rerank?: RerankFunction,
  bankProfile?: BankProfile,
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
    const modelTags: string[] = model.tags ? JSON.parse(model.tags) : []
    const modelIsTagged = modelTags.length > 0
    const hasConsolidatedTags = consolidatedTags.size > 0

    if (hasConsolidatedTags) {
      // Tagged memories were consolidated — refresh:
      // 1. Mental models with overlapping tags (security boundary)
      // 2. Untagged mental models (they're "global")
      // DO NOT refresh mental models with different tags
      if (modelIsTagged) {
        const hasOverlap = modelTags.some((t) => consolidatedTags.has(t))
        if (!hasOverlap) continue
      }
      // Untagged models always get refreshed when tagged memories are consolidated
    } else {
      // Only untagged memories were consolidated — SECURITY: only refresh untagged
      // mental models. Tagged mental models are NOT refreshed when untagged memories
      // are consolidated to prevent info leakage across tag boundaries.
      if (modelIsTagged) continue
    }

    // Fire-and-forget refresh
    refreshMentalModel(hdb, memoryVec, modelVec, adapter, bankId, model.id, rerank, bankProfile)
      .then(() => {})
      .catch(() => {})
    refreshed++
  }

  return refreshed
}

// ── Helpers ─────────────────────────────────────────────────────────────

function mergeObservationHistories(
  observations: Array<typeof import("./schema").memoryUnits.$inferSelect>,
  changedAt: number,
  reason: string,
  sourceMemoryId: string,
): ObservationHistoryEntry[] {
  const history: ObservationHistoryEntry[] = []

  for (const observation of observations) {
    const entries = parseObservationHistory(observation.history)
    history.push(...entries)
  }

  for (const observation of observations) {
    history.push({
      previousText: observation.content,
      changedAt,
      reason,
      sourceMemoryId,
    })
  }

  return history
}

function parseObservationHistory(json: string | null): ObservationHistoryEntry[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as ObservationHistoryEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseStringArrayJson(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as string[]
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
}

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
