import { chat, streamToText } from "@ellie/ai"
import { ulid } from "@ellie/utils"
import { eq } from "drizzle-orm"
import * as v from "valibot"
import type { AnyTextAdapter } from "@tanstack/ai"
import { RecursiveChunker } from "@chonkiejs/core"
import type { HindsightDatabase } from "./db"
import type { EmbeddingStore } from "./embedding"
import type {
  RetainOptions,
  RetainBatchOptions,
  RetainResult,
  RetainBatchResult,
  MemoryUnit,
  Entity,
  FactType,
  EntityType,
  LinkType,
  RerankFunction,
} from "./types"
import { getExtractionPrompt, EXTRACT_FACTS_USER } from "./prompts"
import { sanitizeText, parseLLMJson } from "./sanitize"
import { findDuplicates } from "./dedup"
import { resolveEntity } from "./entity-resolver"
import { consolidate } from "./consolidation"
import type { BankProfile } from "./reflect"

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

// ── Valibot schema for LLM extraction response ────────────────────────────

const ExtractedEntitySchema = v.object({
  name: v.string(),
  entityType: v.picklist([
    "person",
    "organization",
    "place",
    "concept",
    "other",
  ]),
})

const CAUSAL_LINK_TYPES = ["causes", "caused_by", "enables", "prevents"] as const

const CausalRelationSchema = v.object({
  targetIndex: v.number(),
  relationType: v.optional(v.picklist(CAUSAL_LINK_TYPES), "causes"),
  strength: v.optional(v.number(), 1.0),
})

const ExtractedFactSchema = v.object({
  facts: v.array(
    v.object({
      content: v.string(),
      factType: v.picklist(["world", "experience", "opinion", "observation"]),
      confidence: v.optional(v.number(), 1.0),
      validFrom: v.optional(v.nullable(v.string()), null),
      validTo: v.optional(v.nullable(v.string()), null),
      entities: v.optional(v.array(ExtractedEntitySchema), []),
      tags: v.optional(v.array(v.string()), []),
      causalRelations: v.optional(v.array(CausalRelationSchema), []),
    }),
  ),
})

type ExtractedFact = v.InferOutput<typeof ExtractedFactSchema>["facts"][number]

const CHARS_PER_BATCH = 600_000

interface PreparedExtractedFact {
  fact: ExtractedFact
  originalIndex: number
  groupIndex: number
  sourceText: string
}

interface EntityPlan {
  entityMap: Map<string, Entity>
  entityById: Map<string, Entity>
  existingMentionDeltas: Map<string, number>
  newEntities: Array<{
    id: string
    bankId: string
    name: string
    entityType: EntityType
    mentionCount: number
    firstSeen: number
    lastUpdated: number
  }>
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseISOToEpoch(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? null : ms
}

async function extractFactsFromContent(
  adapter: AnyTextAdapter,
  content: string,
  options: RetainOptions | RetainBatchOptions,
): Promise<ExtractedFact[]> {
  if ("facts" in options && options.facts) {
    return options.facts.map((f) => ({
      content: sanitizeText(f.content),
      factType: (f.factType ?? "world") as ExtractedFact["factType"],
      confidence: f.confidence ?? 1.0,
      validFrom: f.validFrom != null ? new Date(f.validFrom).toISOString() : null,
      validTo: f.validTo != null ? new Date(f.validTo).toISOString() : null,
      entities: (f.entities ?? []).map((name) => ({
        name,
        entityType: "concept" as const,
      })),
      tags: f.tags ?? [],
      causalRelations: [],
    }))
  }

  try {
    const systemPrompt = getExtractionPrompt(
      options.mode ?? "concise",
      options.customGuidelines,
    )

    const text = await streamToText(
      chat({
        adapter,
        messages: [{ role: "user", content: EXTRACT_FACTS_USER(content) }],
        systemPrompts: [systemPrompt],
      }),
    )

    const parsed = parseLLMJson(text, { facts: [] })
    const validated = v.safeParse(ExtractedFactSchema, parsed)
    const extracted = validated.success ? validated.output.facts : []
    for (const fact of extracted) {
      fact.content = sanitizeText(fact.content)
    }
    return extracted
  } catch {
    // Graceful degradation: LLM extraction failed, return empty result
    return []
  }
}

function runInTransaction(hdb: HindsightDatabase, fn: () => void): void {
  hdb.sqlite.run("BEGIN")
  try {
    fn()
    hdb.sqlite.run("COMMIT")
  } catch (error) {
    hdb.sqlite.run("ROLLBACK")
    throw error
  }
}

async function chunkWithChonkie(content: string): Promise<string[]> {
  if (content.length <= CHARS_PER_BATCH) return [content]
  const chunker = await RecursiveChunker.create({
    chunkSize: CHARS_PER_BATCH,
    tokenizer: "character",
    minCharactersPerChunk: 1,
  })
  const chunks = await chunker.chunk(content)
  const texts = chunks
    .map((chunk) => sanitizeText(chunk.text).trim())
    .filter((chunkText) => chunkText.length > 0)
  return texts.length > 0 ? texts : [content]
}

async function explodeBatchContents(
  contents: string[],
): Promise<Array<{ originalIndex: number; content: string }>> {
  const chunked = await Promise.all(
    contents.map(async (content, originalIndex) => {
      const sanitized = sanitizeText(content)
      const chunks = await chunkWithChonkie(sanitized)
      return chunks.map((chunk) => ({ originalIndex, content: chunk }))
    }),
  )
  return chunked.flat()
}

function splitByCharacterBudget<T extends { content: string }>(
  items: T[],
  maxChars: number,
): T[][] {
  if (items.length === 0) return []
  const batches: T[][] = []
  let currentBatch: T[] = []
  let currentChars = 0

  for (const item of items) {
    const itemChars = item.content.length
    if (currentBatch.length > 0 && currentChars + itemChars > maxChars) {
      batches.push(currentBatch)
      currentBatch = [item]
      currentChars = itemChars
      continue
    }

    currentBatch.push(item)
    currentChars += itemChars
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch)
  }

  return batches
}

function planEntities(
  hdb: HindsightDatabase,
  bankId: string,
  extracted: PreparedExtractedFact[],
  now: number,
): EntityPlan {
  const existingEntities = hdb.db
    .select()
    .from(hdb.schema.entities)
    .where(eq(hdb.schema.entities.bankId, bankId))
    .all()
  const cooccurrences = loadCooccurrences(hdb, bankId)

  const entityMap = new Map<string, Entity>()
  const entityById = new Map<string, Entity>()
  const existingMentionDeltas = new Map<string, number>()
  const newEntities: EntityPlan["newEntities"] = []
  const newEntityById = new Map<string, EntityPlan["newEntities"][number]>()

  for (const item of extracted) {
    const nearbyNames = item.fact.entities.map((entity) => entity.name)
    for (const ent of item.fact.entities) {
      const key = `${ent.name.toLowerCase()}:${ent.entityType}`
      const seen = entityMap.get(key)
      if (seen) {
        const pending = newEntityById.get(seen.id)
        if (pending) {
          pending.mentionCount += 1
          continue
        }
        existingMentionDeltas.set(
          seen.id,
          (existingMentionDeltas.get(seen.id) ?? 0) + 1,
        )
        continue
      }

      const resolved = resolveEntity(
        ent.name,
        ent.entityType,
        existingEntities,
        cooccurrences,
        nearbyNames.filter((name) => name !== ent.name),
        now,
      )
      const exactMatch = existingEntities.find(
        (row) =>
          row.name.toLowerCase() === ent.name.toLowerCase() &&
          row.entityType === ent.entityType,
      )

      if (resolved || exactMatch) {
        const row =
          (resolved
            ? existingEntities.find((entity) => entity.id === resolved.entityId)
            : exactMatch) ?? null
        if (!row) continue

        const entity = rowToEntity({ ...row, lastUpdated: now })
        entityMap.set(key, entity)
        entityById.set(entity.id, entity)
        existingMentionDeltas.set(
          entity.id,
          (existingMentionDeltas.get(entity.id) ?? 0) + 1,
        )
        continue
      }

      const entityId = ulid()
      const pendingEntity: EntityPlan["newEntities"][number] = {
        id: entityId,
        bankId,
        name: ent.name,
        entityType: ent.entityType as EntityType,
        mentionCount: 1,
        firstSeen: now,
        lastUpdated: now,
      }
      newEntities.push(pendingEntity)
      newEntityById.set(entityId, pendingEntity)

      const entity: Entity = {
        id: entityId,
        bankId,
        name: ent.name,
        entityType: ent.entityType as EntityType,
        description: null,
        metadata: null,
        firstSeen: now,
        lastUpdated: now,
      }
      entityMap.set(key, entity)
      entityById.set(entity.id, entity)
      existingEntities.push({
        id: entityId,
        bankId,
        name: ent.name,
        entityType: ent.entityType,
        description: null,
        metadata: null,
        mentionCount: pendingEntity.mentionCount,
        firstSeen: now,
        lastUpdated: now,
      })
    }
  }

  return {
    entityMap,
    entityById,
    existingMentionDeltas,
    newEntities,
  }
}

function rowToMemoryUnit(
  row: typeof import("./schema").memoryUnits.$inferSelect,
): MemoryUnit {
  return {
    id: row.id,
    bankId: row.bankId,
    content: row.content,
    factType: row.factType as FactType,
    confidence: row.confidence,
    validFrom: row.validFrom,
    validTo: row.validTo,
    metadata: safeJsonParse<Record<string, unknown> | null>(row.metadata, null),
    tags: safeJsonParse<string[] | null>(row.tags, null),
    sourceText: row.sourceText,
    consolidatedAt: row.consolidatedAt,
    proofCount: row.proofCount,
    sourceMemoryIds: safeJsonParse<string[] | null>(row.sourceMemoryIds, null),
    history: safeJsonParse<import("./types").ObservationHistoryEntry[] | null>(row.history, null),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function rowToEntity(
  row: typeof import("./schema").entities.$inferSelect,
): Entity {
  return {
    id: row.id,
    bankId: row.bankId,
    name: row.name,
    entityType: row.entityType as EntityType,
    description: row.description,
    metadata: safeJsonParse<Record<string, unknown> | null>(row.metadata, null),
    firstSeen: row.firstSeen,
    lastUpdated: row.lastUpdated,
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function retain(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  entityVec: EmbeddingStore,
  modelVec: EmbeddingStore,
  adapter: AnyTextAdapter,
  bankId: string,
  content: string,
  options: RetainOptions = {},
  rerank?: RerankFunction,
  bankProfile?: BankProfile,
): Promise<RetainResult> {
  const now = Date.now()
  const { schema } = hdb

  // Sanitize input content
  const cleanContent = sanitizeText(content)

  // ── Step 1: Get facts (LLM extraction or pre-provided) ──
  let extracted = await extractFactsFromContent(adapter, cleanContent, options)

  if (extracted.length === 0) {
    return { memories: [], entities: [], links: [] }
  }

  // ── Step 1b: Deduplication ──

  const dedupThreshold = options.dedupThreshold ?? 0.92
  if (dedupThreshold > 0) {
    const dupes = await findDuplicates(
      hdb,
      memoryVec,
      bankId,
      extracted,
      dedupThreshold,
    )

    // Build old→new index mapping so causal targetIndex refs stay valid
    const indexRemap = new Map<number, number>()
    let newIdx = 0
    for (let oldIdx = 0; oldIdx < extracted.length; oldIdx++) {
      if (!dupes[oldIdx]) {
        indexRemap.set(oldIdx, newIdx++)
      }
    }

    extracted = extracted.filter((_, i) => !dupes[i])

    // Remap causal relation targetIndex values
    for (const fact of extracted) {
      if (!fact.causalRelations) continue
      fact.causalRelations = fact.causalRelations
        .map((rel) => ({
          ...rel,
          targetIndex: indexRemap.get(rel.targetIndex) ?? -1,
        }))
        .filter((rel) => rel.targetIndex >= 0)
    }
  }

  if (extracted.length === 0) {
    return { memories: [], entities: [], links: [] }
  }

  // ── Step 2: Resolve & upsert entities ──

  // Fetch all existing entities + co-occurrences for this bank (single query each)
  const existingEntities = hdb.db
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.bankId, bankId))
    .all()

  const cooccurrences = loadCooccurrences(hdb, bankId)

  const entityMap = new Map<string, Entity>()
  // Track additional mentions per entity ID for batch mentionCount update
  const mentionDeltas = new Map<string, number>()

  for (const fact of extracted) {
    // Collect all entity names in this fact for co-occurrence context
    const nearbyNames = fact.entities.map((e) => e.name)

    for (const ent of fact.entities) {
      const key = `${ent.name.toLowerCase()}:${ent.entityType}`
      if (entityMap.has(key)) {
        // Entity already resolved in this batch — just count the additional mention
        const entity = entityMap.get(key)!
        mentionDeltas.set(entity.id, (mentionDeltas.get(entity.id) ?? 0) + 1)
        continue
      }

      // Try entity resolution first (multi-factor scoring)
      const resolved = resolveEntity(
        ent.name,
        ent.entityType,
        existingEntities,
        cooccurrences,
        nearbyNames.filter((n) => n !== ent.name),
        now,
      )

      if (resolved) {
        // Found a match — update existing entity
        const matchedEntity = existingEntities.find((e) => e.id === resolved.entityId)!
        mentionDeltas.set(matchedEntity.id, (mentionDeltas.get(matchedEntity.id) ?? 0) + 1)

        entityMap.set(key, rowToEntity({ ...matchedEntity, lastUpdated: now }))
      } else {
        // Exact name + type match (fallback before creating new)
        const exactMatch = existingEntities.find(
          (e) =>
            e.name.toLowerCase() === ent.name.toLowerCase() &&
            e.entityType === ent.entityType,
        )

        if (exactMatch) {
          mentionDeltas.set(exactMatch.id, (mentionDeltas.get(exactMatch.id) ?? 0) + 1)
          entityMap.set(key, rowToEntity({ ...exactMatch, lastUpdated: now }))
        } else {
          // Create new entity
          const entityId = ulid()
          hdb.db
            .insert(schema.entities)
            .values({
              id: entityId,
              bankId,
              name: ent.name,
              entityType: ent.entityType,
              mentionCount: 1,
              firstSeen: now,
              lastUpdated: now,
            })
            .run()

          await entityVec.upsert(entityId, ent.name)

          const newEntity: Entity = {
            id: entityId,
            bankId,
            name: ent.name,
            entityType: ent.entityType as EntityType,
            description: null,
            metadata: null,
            firstSeen: now,
            lastUpdated: now,
          }
          entityMap.set(key, newEntity)

          // Add to local cache so subsequent facts in this batch can reference it
          existingEntities.push({
            id: entityId,
            bankId,
            name: ent.name,
            entityType: ent.entityType,
            description: null,
            metadata: null,
            mentionCount: 1,
            firstSeen: now,
            lastUpdated: now,
          })
        }
      }
    }
  }

  // Flush accumulated mention deltas to DB
  for (const [entityId, delta] of mentionDeltas) {
    const entity = existingEntities.find((e) => e.id === entityId)
    if (!entity) continue
    hdb.db
      .update(schema.entities)
      .set({
        lastUpdated: now,
        mentionCount: entity.mentionCount + delta,
      })
      .where(eq(schema.entities.id, entityId))
      .run()
  }

  // ── Step 3: Store memory units + FTS + embeddings ──

  const memories: MemoryUnit[] = []

  for (const fact of extracted) {
    const memoryId = ulid()
    const tags = [...(fact.tags ?? []), ...(options.tags ?? [])]

    hdb.db
      .insert(schema.memoryUnits)
      .values({
        id: memoryId,
        bankId,
        content: fact.content,
        factType: fact.factType,
        confidence: fact.confidence,
        validFrom: parseISOToEpoch(fact.validFrom),
        validTo: parseISOToEpoch(fact.validTo),
        metadata: options.metadata ? JSON.stringify(options.metadata) : null,
        tags: tags.length > 0 ? JSON.stringify(tags) : null,
        sourceText: cleanContent,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    // FTS5
    hdb.sqlite.run(
      "INSERT INTO hs_memory_fts (id, bank_id, content) VALUES (?, ?, ?)",
      [memoryId, bankId, fact.content],
    )

    // Embedding
    await memoryVec.upsert(memoryId, fact.content)

    // Memory ↔ Entity junction
    const linkedEntityIds: string[] = []
    for (const ent of fact.entities) {
      const key = `${ent.name.toLowerCase()}:${ent.entityType}`
      const entity = entityMap.get(key)
      if (entity) {
        hdb.db
          .insert(schema.memoryEntities)
          .values({ memoryId, entityId: entity.id })
          .run()
        linkedEntityIds.push(entity.id)
      }
    }

    // Update co-occurrence table for all entity pairs linked to this memory
    updateCooccurrences(hdb, bankId, linkedEntityIds)

    memories.push({
      id: memoryId,
      bankId,
      content: fact.content,
      factType: fact.factType as FactType,
      confidence: fact.confidence,
      validFrom: parseISOToEpoch(fact.validFrom),
      validTo: parseISOToEpoch(fact.validTo),
      metadata: options.metadata ?? null,
      tags: tags.length > 0 ? tags : null,
      sourceText: cleanContent,
      consolidatedAt: null,
      proofCount: 0,
      sourceMemoryIds: null,
      history: null,
      createdAt: now,
      updatedAt: now,
    })
  }

  // ── Step 4: Create entity-based links between co-occurring memories ──

  const links: RetainResult["links"] = []

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const entitiesI = new Set(
        extracted[i]!.entities.map((e) => e.name.toLowerCase()),
      )
      const entitiesJ = new Set(
        extracted[j]!.entities.map((e) => e.name.toLowerCase()),
      )
      const shared = [...entitiesI].filter((e) => entitiesJ.has(e))

      if (shared.length > 0) {
        const linkId = ulid()
        const weight =
          shared.length / Math.max(entitiesI.size, entitiesJ.size, 1)

        hdb.db
          .insert(schema.memoryLinks)
          .values({
            id: linkId,
            bankId,
            sourceId: memories[i]!.id,
            targetId: memories[j]!.id,
            linkType: "entity",
            weight,
            createdAt: now,
          })
          .run()

        links.push({
          sourceId: memories[i]!.id,
          targetId: memories[j]!.id,
          linkType: "entity" as LinkType,
        })
      }
    }
  }

  // ── Step 5: Create causal links ──

  for (let i = 0; i < extracted.length; i++) {
    const fact = extracted[i]!
    for (const rel of fact.causalRelations ?? []) {
      if (rel.targetIndex < 0 || rel.targetIndex >= i) continue // only backward refs
      const sourceId = memories[i]!.id
      const targetId = memories[rel.targetIndex]!.id
      if (sourceId === targetId) continue

      const linkType = rel.relationType ?? "causes"

      hdb.db
        .insert(schema.memoryLinks)
        .values({
          id: ulid(),
          bankId,
          sourceId,
          targetId,
          linkType,
          weight: rel.strength,
          createdAt: now,
        })
        .run()

      links.push({ sourceId, targetId, linkType })
    }
  }

  // ── Step 6: Create semantic links ──

  const semanticLinks = await createSemanticLinks(
    hdb,
    memoryVec,
    bankId,
    memories.map((m) => m.id),
  )
  links.push(...semanticLinks)

  // ── Step 7: Auto-consolidate (creates observations + refreshes mental models) ──

  const shouldConsolidate = options.consolidate !== false

  if (shouldConsolidate) {
    // Fire-and-forget — don't block retain
    consolidate(hdb, memoryVec, modelVec, adapter, bankId, {}, rerank, bankProfile).catch(
      () => {}, // swallow errors — consolidation is best-effort
    )
  }

  return {
    memories,
    entities: Array.from(entityMap.values()),
    links,
  }
}

export async function retainBatch(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  entityVec: EmbeddingStore,
  modelVec: EmbeddingStore,
  adapter: AnyTextAdapter,
  bankId: string,
  contents: string[],
  options: RetainBatchOptions = {},
  rerank?: RerankFunction,
): Promise<RetainBatchResult> {
  if (contents.length === 0) return []

  const expandedContents = await explodeBatchContents(contents)
  const subBatches = splitByCharacterBudget(expandedContents, CHARS_PER_BATCH)
  const aggregate = contents.map<RetainResult>(() => ({
    memories: [],
    entities: [],
    links: [],
  }))
  const entityIdsByResult = contents.map(() => new Set<string>())
  const entityById = new Map<string, Entity>()
  const linkKeysByResult = contents.map(() => new Set<string>())
  const memoryIdsToOriginalIndex = new Map<string, number>()

  for (const subBatch of subBatches) {
    const extractedPerContent = await Promise.all(
      subBatch.map(async ({ content }) =>
        extractFactsFromContent(adapter, content, options),
      ),
    )

    const flattened: PreparedExtractedFact[] = []
    for (let groupIndex = 0; groupIndex < subBatch.length; groupIndex++) {
      const { originalIndex, content } = subBatch[groupIndex]!
      const extracted = extractedPerContent[groupIndex]!
      for (const fact of extracted) {
        flattened.push({
          fact,
          originalIndex,
          groupIndex,
          sourceText: content,
        })
      }
    }

    if (flattened.length === 0) continue

    const dedupThreshold = options.dedupThreshold ?? 0.92
    const allVectors = await memoryVec.createVectors(
      flattened.map((item) => item.fact.content),
    )

    const dedupFlags =
      dedupThreshold > 0
        ? findDuplicateFlagsByVector(
            hdb,
            memoryVec,
            bankId,
            allVectors,
            dedupThreshold,
          )
        : flattened.map(() => false)

    const retainedFacts: PreparedExtractedFact[] = []
    const retainedVectors: Float32Array[] = []
    for (let i = 0; i < flattened.length; i++) {
      if (dedupFlags[i]) continue
      retainedFacts.push(flattened[i]!)
      retainedVectors.push(allVectors[i]!)
    }

    if (retainedFacts.length === 0) continue

    const now = Date.now()
    const entityPlan = planEntities(hdb, bankId, retainedFacts, now)
    for (const [entityId, entity] of entityPlan.entityById.entries()) {
      entityById.set(entityId, entity)
    }
    const entityVectors = await entityVec.createVectors(
      entityPlan.newEntities.map((entity) => entity.name),
    )

    const memoryRows: Array<typeof hdb.schema.memoryUnits.$inferInsert> = []
    const memoryRecords: Array<{
      memory: MemoryUnit
      originalIndex: number
      fact: ExtractedFact
      vector: Float32Array
    }> = []
    const memoryEntityIds = new Map<string, string[]>()
    const memoryEntityNames = new Map<string, Set<string>>()
    const memoryIdsByGroup = new Map<number, string[]>()

    for (let i = 0; i < retainedFacts.length; i++) {
      const item = retainedFacts[i]!
      const memoryId = ulid()
      const tags = [...(item.fact.tags ?? []), ...(options.tags ?? [])]

      memoryRows.push({
        id: memoryId,
        bankId,
        content: item.fact.content,
        factType: item.fact.factType,
        confidence: item.fact.confidence,
        validFrom: parseISOToEpoch(item.fact.validFrom),
        validTo: parseISOToEpoch(item.fact.validTo),
        metadata: options.metadata ? JSON.stringify(options.metadata) : null,
        tags: tags.length > 0 ? JSON.stringify(tags) : null,
        sourceText: item.sourceText,
        createdAt: now,
        updatedAt: now,
      })

      const memory: MemoryUnit = {
        id: memoryId,
        bankId,
        content: item.fact.content,
        factType: item.fact.factType as FactType,
        confidence: item.fact.confidence,
        validFrom: parseISOToEpoch(item.fact.validFrom),
        validTo: parseISOToEpoch(item.fact.validTo),
        metadata: options.metadata ?? null,
        tags: tags.length > 0 ? tags : null,
        sourceText: item.sourceText,
        consolidatedAt: null,
        proofCount: 0,
        sourceMemoryIds: null,
        history: null,
        createdAt: now,
        updatedAt: now,
      }

      const linkedEntityIds: string[] = []
      const linkedEntityNames = new Set<string>()
      for (const ent of item.fact.entities) {
        const key = `${ent.name.toLowerCase()}:${ent.entityType}`
        const entity = entityPlan.entityMap.get(key)
        if (!entity) continue
        linkedEntityIds.push(entity.id)
        linkedEntityNames.add(ent.name.toLowerCase())
        entityIdsByResult[item.originalIndex]!.add(entity.id)
      }

      memoryEntityIds.set(memoryId, linkedEntityIds)
      memoryEntityNames.set(memoryId, linkedEntityNames)
      memoryRecords.push({
        memory,
        originalIndex: item.originalIndex,
        fact: item.fact,
        vector: retainedVectors[i]!,
      })
      const groupMemoryIds = memoryIdsByGroup.get(item.groupIndex) ?? []
      groupMemoryIds.push(memoryId)
      memoryIdsByGroup.set(item.groupIndex, groupMemoryIds)
      memoryIdsToOriginalIndex.set(memoryId, item.originalIndex)
    }

    const existingById = new Map(
      hdb.db
        .select()
        .from(hdb.schema.entities)
        .where(eq(hdb.schema.entities.bankId, bankId))
        .all()
        .map((row) => [row.id, row]),
    )

    const createdLinks: RetainResult["links"] = []

    runInTransaction(hdb, () => {
      for (const [entityId, delta] of entityPlan.existingMentionDeltas.entries()) {
        const existing = existingById.get(entityId)
        if (!existing) continue
        hdb.db
          .update(hdb.schema.entities)
          .set({
            lastUpdated: now,
            mentionCount: existing.mentionCount + delta,
          })
          .where(eq(hdb.schema.entities.id, entityId))
          .run()
      }

      for (const newEntity of entityPlan.newEntities) {
        hdb.db.insert(hdb.schema.entities).values(newEntity).run()
      }

      entityVec.upsertVectors(
        entityPlan.newEntities.map((entity, index) => ({
          id: entity.id,
          vector: entityVectors[index]!,
        })),
      )

      for (const row of memoryRows) {
        hdb.db.insert(hdb.schema.memoryUnits).values(row).run()
        hdb.sqlite.run(
          "INSERT INTO hs_memory_fts (id, bank_id, content) VALUES (?, ?, ?)",
          [row.id, bankId, row.content],
        )
      }

      memoryVec.upsertVectors(
        memoryRecords.map((item) => ({
          id: item.memory.id,
          vector: item.vector,
        })),
      )

      for (const memory of memoryRecords) {
        const linkedEntityIds = memoryEntityIds.get(memory.memory.id) ?? []
        for (const entityId of linkedEntityIds) {
          hdb.db
            .insert(hdb.schema.memoryEntities)
            .values({ memoryId: memory.memory.id, entityId })
            .run()
        }
        updateCooccurrences(hdb, bankId, linkedEntityIds)
      }

      createEntityLinksFromMemories(
        hdb,
        bankId,
        memoryRecords.map((record) => record.memory.id),
        memoryEntityNames,
        now,
        createdLinks,
      )

      createCausalLinksFromGroups(
        hdb,
        bankId,
        retainedFacts,
        memoryIdsByGroup,
        now,
        createdLinks,
      )

      createSemanticLinksFromVectors(
        hdb,
        memoryVec,
        bankId,
        memoryRecords.map((record) => ({
          id: record.memory.id,
          vector: record.vector,
        })),
        now,
        createdLinks,
      )
    })

    for (const memory of memoryRecords) {
      aggregate[memory.originalIndex]!.memories.push(memory.memory)
    }

    for (const link of createdLinks) {
      const sourceIndex = memoryIdsToOriginalIndex.get(link.sourceId)
      const targetIndex = memoryIdsToOriginalIndex.get(link.targetId)
      if (sourceIndex !== undefined) {
        addUniqueLink(aggregate[sourceIndex]!, linkKeysByResult[sourceIndex]!, link)
      }
      if (targetIndex !== undefined && targetIndex !== sourceIndex) {
        addUniqueLink(aggregate[targetIndex]!, linkKeysByResult[targetIndex]!, link)
      }
    }
  }

  for (let i = 0; i < aggregate.length; i++) {
    aggregate[i]!.entities = [...entityIdsByResult[i]!]
      .map((entityId) => entityById.get(entityId))
      .filter((entity): entity is Entity => Boolean(entity))
  }

  if (options.consolidate !== false) {
    consolidate(hdb, memoryVec, modelVec, adapter, bankId, {}, rerank).catch(() => {
      // consolidation is best-effort
    })
  }

  return aggregate
}

// ── Semantic Links ─────────────────────────────────────────────────────────

const DUPLICATE_SEARCH_K = 5
const SEMANTIC_LINK_THRESHOLD = 0.7
const SEMANTIC_LINK_TOP_K = 5

function findDuplicateFlagsByVector(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  vectors: Float32Array[],
  threshold: number,
): boolean[] {
  const flags: boolean[] = []

  for (const vector of vectors) {
    const hits = memoryVec.searchByVector(vector, DUPLICATE_SEARCH_K)
    let isDuplicate = false

    for (const hit of hits) {
      const similarity = 1 - hit.distance
      if (similarity < threshold) break

      const row = hdb.db
        .select({ bankId: hdb.schema.memoryUnits.bankId })
        .from(hdb.schema.memoryUnits)
        .where(eq(hdb.schema.memoryUnits.id, hit.id))
        .get()
      if (row?.bankId !== bankId) continue
      isDuplicate = true
      break
    }

    flags.push(isDuplicate)
  }

  return flags
}

function createEntityLinksFromMemories(
  hdb: HindsightDatabase,
  bankId: string,
  memoryIds: string[],
  memoryEntityNames: Map<string, Set<string>>,
  createdAt: number,
  output: RetainResult["links"],
): void {
  for (let i = 0; i < memoryIds.length; i++) {
    const sourceId = memoryIds[i]!
    const sourceEntities = memoryEntityNames.get(sourceId) ?? new Set<string>()
    for (let j = i + 1; j < memoryIds.length; j++) {
      const targetId = memoryIds[j]!
      const targetEntities = memoryEntityNames.get(targetId) ?? new Set<string>()
      const shared = [...sourceEntities].filter((name) =>
        targetEntities.has(name),
      )
      if (shared.length === 0) continue

      const weight =
        shared.length /
        Math.max(sourceEntities.size, targetEntities.size, 1)

      hdb.db
        .insert(hdb.schema.memoryLinks)
        .values({
          id: ulid(),
          bankId,
          sourceId,
          targetId,
          linkType: "entity",
          weight,
          createdAt,
        })
        .run()

      output.push({ sourceId, targetId, linkType: "entity" })
    }
  }
}

function createCausalLinksFromGroups(
  hdb: HindsightDatabase,
  bankId: string,
  facts: PreparedExtractedFact[],
  memoryIdsByGroup: Map<number, string[]>,
  createdAt: number,
  output: RetainResult["links"],
): void {
  const factsByGroup = new Map<number, PreparedExtractedFact[]>()
  for (const fact of facts) {
    const list = factsByGroup.get(fact.groupIndex) ?? []
    list.push(fact)
    factsByGroup.set(fact.groupIndex, list)
  }

  for (const [groupIndex, groupFacts] of factsByGroup.entries()) {
    const groupMemoryIds = memoryIdsByGroup.get(groupIndex) ?? []
    for (let i = 0; i < groupFacts.length; i++) {
      const sourceId = groupMemoryIds[i]
      const fact = groupFacts[i]
      if (!sourceId || !fact) continue

      for (const relation of fact.fact.causalRelations ?? []) {
        if (relation.targetIndex < 0 || relation.targetIndex >= i) continue
        const targetId = groupMemoryIds[relation.targetIndex]
        if (!targetId || sourceId === targetId) continue

        const linkType = relation.relationType ?? "causes"
        hdb.db
          .insert(hdb.schema.memoryLinks)
          .values({
            id: ulid(),
            bankId,
            sourceId,
            targetId,
            linkType,
            weight: relation.strength,
            createdAt,
          })
          .run()

        output.push({ sourceId, targetId, linkType })
      }
    }
  }
}

function createSemanticLinksFromVectors(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  newMemories: Array<{ id: string; vector: Float32Array }>,
  createdAt: number,
  output: RetainResult["links"],
): void {
  const newMemoryIds = new Set(newMemories.map((memory) => memory.id))

  for (const memory of newMemories) {
    const hits = memoryVec.searchByVector(memory.vector, SEMANTIC_LINK_TOP_K + 1)

    for (const hit of hits) {
      if (hit.id === memory.id || newMemoryIds.has(hit.id)) continue
      const similarity = 1 - hit.distance
      if (similarity < SEMANTIC_LINK_THRESHOLD) continue

      const row = hdb.db
        .select({ bankId: hdb.schema.memoryUnits.bankId })
        .from(hdb.schema.memoryUnits)
        .where(eq(hdb.schema.memoryUnits.id, hit.id))
        .get()
      if (row?.bankId !== bankId) continue

      hdb.db
        .insert(hdb.schema.memoryLinks)
        .values({
          id: ulid(),
          bankId,
          sourceId: memory.id,
          targetId: hit.id,
          linkType: "semantic",
          weight: similarity,
          createdAt,
        })
        .run()

      output.push({
        sourceId: memory.id,
        targetId: hit.id,
        linkType: "semantic",
      })
    }
  }
}

function addUniqueLink(
  result: RetainResult,
  linkKeys: Set<string>,
  link: RetainResult["links"][number],
): void {
  const key = `${link.sourceId}:${link.targetId}:${link.linkType}`
  if (linkKeys.has(key)) return
  linkKeys.add(key)
  result.links.push(link)
}

async function createSemanticLinks(
  hdb: HindsightDatabase,
  memoryVec: EmbeddingStore,
  bankId: string,
  newMemoryIds: string[],
): Promise<RetainResult["links"]> {
  const links: RetainResult["links"] = []
  const newIdSet = new Set(newMemoryIds)

  for (const memoryId of newMemoryIds) {
    const row = hdb.db
      .select({ content: hdb.schema.memoryUnits.content })
      .from(hdb.schema.memoryUnits)
      .where(eq(hdb.schema.memoryUnits.id, memoryId))
      .get()
    if (!row) continue

    const hits = await memoryVec.search(row.content, SEMANTIC_LINK_TOP_K + 1)

    for (const hit of hits) {
      // Skip self and other new memories (entity links already cover within-batch)
      if (hit.id === memoryId || newIdSet.has(hit.id)) continue

      const similarity = 1 - hit.distance
      if (similarity < SEMANTIC_LINK_THRESHOLD) continue

      // Verify same bank
      const memRow = hdb.db
        .select({ bankId: hdb.schema.memoryUnits.bankId })
        .from(hdb.schema.memoryUnits)
        .where(eq(hdb.schema.memoryUnits.id, hit.id))
        .get()
      if (memRow?.bankId !== bankId) continue

      hdb.db
        .insert(hdb.schema.memoryLinks)
        .values({
          id: ulid(),
          bankId,
          sourceId: memoryId,
          targetId: hit.id,
          linkType: "semantic",
          weight: similarity,
          createdAt: Date.now(),
        })
        .run()

      links.push({
        sourceId: memoryId,
        targetId: hit.id,
        linkType: "semantic" as LinkType,
      })
    }
  }

  return links
}

// ── Co-occurrence Helpers ──────────────────────────────────────────────────

/**
 * Load all co-occurrence data for a bank into a Map<entityId, Set<entityId>>.
 */
function loadCooccurrences(
  hdb: HindsightDatabase,
  bankId: string,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()

  const rows = hdb.db
    .select()
    .from(hdb.schema.entityCooccurrences)
    .where(eq(hdb.schema.entityCooccurrences.bankId, bankId))
    .all()

  for (const row of rows) {
    if (!map.has(row.entityA)) map.set(row.entityA, new Set())
    if (!map.has(row.entityB)) map.set(row.entityB, new Set())
    map.get(row.entityA)!.add(row.entityB)
    map.get(row.entityB)!.add(row.entityA)
  }

  return map
}

/**
 * Update co-occurrence counts for all pairs of entities linked to a memory.
 * Convention: always store smaller ULID first (entityA < entityB).
 */
function updateCooccurrences(
  hdb: HindsightDatabase,
  bankId: string,
  entityIds: string[],
): void {
  for (let i = 0; i < entityIds.length; i++) {
    for (let j = i + 1; j < entityIds.length; j++) {
      const [entityA, entityB] =
        entityIds[i]! < entityIds[j]!
          ? [entityIds[i]!, entityIds[j]!]
          : [entityIds[j]!, entityIds[i]!]

      // Use raw SQL for upsert (ON CONFLICT UPDATE)
      hdb.sqlite.run(
        `INSERT INTO hs_entity_cooccurrences (bank_id, entity_a, entity_b, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (bank_id, entity_a, entity_b)
         DO UPDATE SET count = count + 1`,
        [bankId, entityA, entityB],
      )
    }
  }
}

export { rowToMemoryUnit, rowToEntity }
