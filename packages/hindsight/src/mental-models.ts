/**
 * Mental models — user-curated summaries with freshness tracking.
 *
 * A mental model stores a `sourceQuery` that can be re-run through reflect()
 * to regenerate the content. They sit at the top of the retrieval hierarchy:
 * mental models > observations > raw facts.
 */

import { ulid } from "@ellie/utils"
import { eq, and } from "drizzle-orm"
import type { AnyTextAdapter } from "@tanstack/ai"
import type { HindsightDatabase } from "./db"
import type { EmbeddingStore } from "./embedding"
import type {
  MentalModel,
  MentalModelSearchResult,
  CreateMentalModelOptions,
  UpdateMentalModelOptions,
  RefreshMentalModelResult,
  RerankFunction,
} from "./types"
import { reflect, type BankProfile } from "./reflect"
import type { MentalModelRow } from "./schema"

// ── Helpers ────────────────────────────────────────────────────────────────

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function rowToMentalModel(row: MentalModelRow): MentalModel {
  return {
    id: row.id,
    bankId: row.bankId,
    name: row.name,
    sourceQuery: row.sourceQuery,
    content: row.content,
    sourceMemoryIds: safeJsonParse<string[] | null>(row.sourceMemoryIds, null),
    tags: safeJsonParse<string[] | null>(row.tags, null),
    autoRefresh: row.autoRefresh === 1,
    lastRefreshedAt: row.lastRefreshedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function createMentalModel(
  hdb: HindsightDatabase,
  modelVec: EmbeddingStore,
  bankId: string,
  options: CreateMentalModelOptions,
): Promise<MentalModel> {
  const id = ulid()
  const now = Date.now()

  hdb.db
    .insert(hdb.schema.mentalModels)
    .values({
      id,
      bankId,
      name: options.name,
      sourceQuery: options.sourceQuery,
      content: options.content ?? null,
      tags: options.tags ? JSON.stringify(options.tags) : null,
      autoRefresh: options.autoRefresh ? 1 : 0,
      lastRefreshedAt: options.content ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  // Embed the source query for semantic matching
  await modelVec.upsert(id, options.sourceQuery)

  return {
    id,
    bankId,
    name: options.name,
    sourceQuery: options.sourceQuery,
    content: options.content ?? null,
    sourceMemoryIds: null,
    tags: options.tags ?? null,
    autoRefresh: options.autoRefresh ?? false,
    lastRefreshedAt: options.content ? now : null,
    createdAt: now,
    updatedAt: now,
  }
}

export function getMentalModel(
  hdb: HindsightDatabase,
  bankId: string,
  id: string,
): MentalModel | undefined {
  const row = hdb.db
    .select()
    .from(hdb.schema.mentalModels)
    .where(
      and(
        eq(hdb.schema.mentalModels.bankId, bankId),
        eq(hdb.schema.mentalModels.id, id),
      ),
    )
    .get()
  return row ? rowToMentalModel(row) : undefined
}

export function listMentalModels(
  hdb: HindsightDatabase,
  bankId: string,
): MentalModel[] {
  return hdb.db
    .select()
    .from(hdb.schema.mentalModels)
    .where(eq(hdb.schema.mentalModels.bankId, bankId))
    .all()
    .map(rowToMentalModel)
}

export async function updateMentalModel(
  hdb: HindsightDatabase,
  modelVec: EmbeddingStore,
  bankId: string,
  id: string,
  options: UpdateMentalModelOptions,
): Promise<MentalModel> {
  const now = Date.now()

  const updates: Record<string, unknown> = { updatedAt: now }

  if (options.name !== undefined) updates.name = options.name
  if (options.sourceQuery !== undefined) updates.sourceQuery = options.sourceQuery
  if (options.content !== undefined) {
    updates.content = options.content
    updates.lastRefreshedAt = now
  }
  if (options.tags !== undefined) updates.tags = JSON.stringify(options.tags)
  if (options.autoRefresh !== undefined) updates.autoRefresh = options.autoRefresh ? 1 : 0

  hdb.db
    .update(hdb.schema.mentalModels)
    .set(updates)
    .where(
      and(
        eq(hdb.schema.mentalModels.bankId, bankId),
        eq(hdb.schema.mentalModels.id, id),
      ),
    )
    .run()

  // Re-embed if sourceQuery changed
  if (options.sourceQuery !== undefined) {
    await modelVec.upsert(id, options.sourceQuery)
  }

  const row = hdb.db
    .select()
    .from(hdb.schema.mentalModels)
    .where(
      and(
        eq(hdb.schema.mentalModels.bankId, bankId),
        eq(hdb.schema.mentalModels.id, id),
      ),
    )
    .get()

  if (!row) throw new Error(`Mental model ${id} not found in bank ${bankId}`)
  return rowToMentalModel(row)
}

export function deleteMentalModel(
  hdb: HindsightDatabase,
  modelVec: EmbeddingStore,
  bankId: string,
  id: string,
): void {
  hdb.db
    .delete(hdb.schema.mentalModels)
    .where(
      and(
        eq(hdb.schema.mentalModels.bankId, bankId),
        eq(hdb.schema.mentalModels.id, id),
      ),
    )
    .run()

  modelVec.delete(id)
}

// ── Refresh ────────────────────────────────────────────────────────────────

export async function refreshMentalModel(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  modelVec: EmbeddingStore,
  adapter: AnyTextAdapter,
  bankId: string,
  id: string,
  rerank?: RerankFunction,
  bankProfile?: BankProfile,
): Promise<RefreshMentalModelResult> {
  const row = hdb.db
    .select()
    .from(hdb.schema.mentalModels)
    .where(
      and(
        eq(hdb.schema.mentalModels.bankId, bankId),
        eq(hdb.schema.mentalModels.id, id),
      ),
    )
    .get()

  if (!row) throw new Error(`Mental model ${id} not found in bank ${bankId}`)

  // Run the source query through reflect (without modelVec to avoid recursion)
  const reflectResult = await reflect(
    hdb,
    memoryVec,
    null, // no modelVec — don't look up mental models during refresh
    adapter,
    bankId,
    row.sourceQuery,
    { saveObservations: false },
    rerank,
    bankProfile,
  )

  const now = Date.now()
  const sourceMemoryIds = reflectResult.memories.map((m) => m.memory.id)

  hdb.db
    .update(hdb.schema.mentalModels)
    .set({
      content: reflectResult.answer,
      sourceMemoryIds: JSON.stringify(sourceMemoryIds),
      lastRefreshedAt: now,
      updatedAt: now,
    })
    .where(eq(hdb.schema.mentalModels.id, id))
    .run()

  // Re-embed the new content for better semantic matching
  if (reflectResult.answer.trim()) {
    await modelVec.upsert(id, reflectResult.answer)
  }

  const updated = hdb.db
    .select()
    .from(hdb.schema.mentalModels)
    .where(eq(hdb.schema.mentalModels.id, id))
    .get()

  return {
    model: rowToMentalModel(updated!),
    reflectResult,
  }
}

// ── Semantic Matching ──────────────────────────────────────────────────────

const DEFAULT_MATCH_THRESHOLD = 0.85

/**
 * Find mental models whose content/query is semantically similar to the given query.
 * Used by reflect() to check for pre-computed answers before running the full agent loop.
 */
export async function findMatchingModels(
  hdb: HindsightDatabase,
  modelVec: EmbeddingStore,
  bankId: string,
  query: string,
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): Promise<MentalModel[]> {
  const hits = await modelVec.search(query, 5)
  const models: MentalModel[] = []

  for (const hit of hits) {
    const similarity = 1 - hit.distance
    if (similarity < threshold) continue

    const row = hdb.db
      .select()
      .from(hdb.schema.mentalModels)
      .where(
        and(
          eq(hdb.schema.mentalModels.id, hit.id),
          eq(hdb.schema.mentalModels.bankId, bankId),
        ),
      )
      .get()

    if (row && row.content) {
      models.push(rowToMentalModel(row))
    }
  }

  return models
}

// ── Tiered Search (for reflect 3-tier tools) ────────────────────────────

const SEARCH_THRESHOLD = 0.5
const STALE_DAYS = 7
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000

/**
 * Search mental models with staleness metadata.
 *
 * Lower threshold than `findMatchingModels()` (0.5 vs 0.85) because the LLM
 * decides relevance. Returns `MentalModelSearchResult[]` with `isStale` flag
 * based on a 7-day freshness window.
 *
 * Used by the reflect agent's `search_mental_models` tool (Tier 1).
 */
export async function searchMentalModelsWithStaleness(
  hdb: HindsightDatabase,
  modelVec: EmbeddingStore,
  bankId: string,
  query: string,
  limit: number = 5,
): Promise<MentalModelSearchResult[]> {
  const hits = await modelVec.search(query, limit)
  const results: MentalModelSearchResult[] = []
  const now = Date.now()
  const staleCutoff = now - STALE_MS

  for (const hit of hits) {
    const similarity = 1 - hit.distance
    if (similarity < SEARCH_THRESHOLD) continue

    const row = hdb.db
      .select()
      .from(hdb.schema.mentalModels)
      .where(
        and(
          eq(hdb.schema.mentalModels.id, hit.id),
          eq(hdb.schema.mentalModels.bankId, bankId),
        ),
      )
      .get()

    if (!row || !row.content) continue

    const lastRefreshed = row.lastRefreshedAt ?? row.createdAt
    const isStale = lastRefreshed < staleCutoff

    results.push({
      id: row.id,
      name: row.name,
      content: row.content,
      tags: row.tags ? JSON.parse(row.tags) : null,
      relevanceScore: similarity,
      updatedAt: row.updatedAt,
      isStale,
    })
  }

  return results
}
