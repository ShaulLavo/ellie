import { chat, streamToText } from "@ellie/ai"
import { ulid } from "@ellie/utils"
import { eq } from "drizzle-orm"
import * as v from "valibot"
import type { AnyTextAdapter } from "@tanstack/ai"
import type { HindsightDatabase } from "./db"
import type { EmbeddingStore } from "./embedding"
import type {
  RetainOptions,
  RetainResult,
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

// ── Helpers ────────────────────────────────────────────────────────────────

function parseISOToEpoch(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? null : ms
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
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    tags: row.tags ? JSON.parse(row.tags) : null,
    sourceText: row.sourceText,
    consolidatedAt: row.consolidatedAt,
    proofCount: row.proofCount,
    sourceMemoryIds: row.sourceMemoryIds ? JSON.parse(row.sourceMemoryIds) : null,
    history: row.history ? JSON.parse(row.history) : null,
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
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
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
): Promise<RetainResult> {
  const now = Date.now()
  const { schema } = hdb

  // Sanitize input content
  const cleanContent = sanitizeText(content)

  // ── Step 1: Get facts (LLM extraction or pre-provided) ──

  let extracted: ExtractedFact[]

  if (options.facts) {
    extracted = options.facts.map((f) => ({
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
  } else {
    try {
      const systemPrompt = getExtractionPrompt(
        options.mode ?? "concise",
        options.customGuidelines,
      )

      const text = await streamToText(
        chat({
          adapter,
          messages: [{ role: "user", content: EXTRACT_FACTS_USER(cleanContent) }],
          systemPrompts: [systemPrompt],
        }),
      )

      const parsed = parseLLMJson(text, { facts: [] })
      const validated = v.safeParse(ExtractedFactSchema, parsed)
      extracted = validated.success ? validated.output.facts : []
    } catch {
      // Graceful degradation: LLM extraction failed, return empty result
      extracted = []
    }
  }

  // Sanitize each extracted fact's content
  for (const fact of extracted) {
    fact.content = sanitizeText(fact.content)
  }

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
    extracted = extracted.filter((_, i) => !dupes[i])
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

  for (const fact of extracted) {
    // Collect all entity names in this fact for co-occurrence context
    const nearbyNames = fact.entities.map((e) => e.name)

    for (const ent of fact.entities) {
      const key = `${ent.name.toLowerCase()}:${ent.entityType}`
      if (entityMap.has(key)) continue

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
        hdb.db
          .update(schema.entities)
          .set({
            lastUpdated: now,
            mentionCount: matchedEntity.mentionCount + 1,
          })
          .where(eq(schema.entities.id, resolved.entityId))
          .run()

        entityMap.set(key, rowToEntity({ ...matchedEntity, lastUpdated: now }))
      } else {
        // Exact name + type match (fallback before creating new)
        const exactMatch = existingEntities.find(
          (e) =>
            e.name.toLowerCase() === ent.name.toLowerCase() &&
            e.entityType === ent.entityType,
        )

        if (exactMatch) {
          hdb.db
            .update(schema.entities)
            .set({
              lastUpdated: now,
              mentionCount: exactMatch.mentionCount + 1,
            })
            .where(eq(schema.entities.id, exactMatch.id))
            .run()
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
    consolidate(hdb, memoryVec, modelVec, adapter, bankId, {}, rerank).catch(
      () => {}, // swallow errors — consolidation is best-effort
    )
  }

  return {
    memories,
    entities: Array.from(entityMap.values()),
    links,
  }
}

// ── Semantic Links ─────────────────────────────────────────────────────────

const SEMANTIC_LINK_THRESHOLD = 0.7
const SEMANTIC_LINK_TOP_K = 5

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
         ON CONFLICT (entity_a, entity_b)
         DO UPDATE SET count = count + 1`,
        [bankId, entityA, entityB],
      )
    }
  }
}

export { rowToMemoryUnit, rowToEntity }
