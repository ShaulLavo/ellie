import * as v from "valibot"
import { createRouter } from "@ellie/rpc/server"
import { agentMessageSchema, agentEventSchema } from "@ellie/agent"
import type { CollectionDef, StreamDef, ProcedureDef, Router } from "@ellie/rpc"

// ============================================================================
// Stream Schemas
// ============================================================================

export const messageSchema = v.object({
  id: v.string(),
  role: v.picklist([`user`, `assistant`, `system`]),
  content: v.string(),
  createdAt: v.string(),
})

// ============================================================================
// Shared Hindsight Schemas
// ============================================================================

const factTypeSchema = v.picklist([`world`, `experience`, `opinion`, `observation`])

const entityTypeSchema = v.picklist([`person`, `organization`, `place`, `concept`, `other`])

const linkTypeSchema = v.picklist([
  `temporal`, `semantic`, `entity`, `causes`, `caused_by`, `enables`, `prevents`,
])

const tagsMatchSchema = v.picklist([`any`, `all`, `any_strict`, `all_strict`])

const reflectBudgetSchema = v.picklist([`low`, `mid`, `high`])

const dispositionTraitsSchema = v.object({
  skepticism: v.number(),
  literalism: v.number(),
  empathy: v.number(),
})

const bankConfigSchema = v.object({
  extractionMode: v.optional(v.picklist([`concise`, `verbose`, `custom`])),
  customGuidelines: v.optional(v.nullable(v.string())),
  enableConsolidation: v.optional(v.boolean()),
  reflectBudget: v.optional(reflectBudgetSchema),
  dedupThreshold: v.optional(v.number()),
})

// ── Data objects ──

const observationHistoryEntrySchema = v.object({
  previousText: v.string(),
  changedAt: v.number(),
  reason: v.string(),
  sourceMemoryId: v.string(),
})

const memoryUnitSchema = v.object({
  id: v.string(),
  bankId: v.string(),
  content: v.string(),
  factType: factTypeSchema,
  confidence: v.number(),
  documentId: v.nullable(v.string()),
  chunkId: v.nullable(v.string()),
  eventDate: v.nullable(v.number()),
  occurredStart: v.nullable(v.number()),
  occurredEnd: v.nullable(v.number()),
  mentionedAt: v.nullable(v.number()),
  metadata: v.nullable(v.record(v.string(), v.unknown())),
  tags: v.nullable(v.array(v.string())),
  sourceText: v.nullable(v.string()),
  consolidatedAt: v.nullable(v.number()),
  proofCount: v.number(),
  sourceMemoryIds: v.nullable(v.array(v.string())),
  history: v.nullable(v.array(observationHistoryEntrySchema)),
  createdAt: v.number(),
  updatedAt: v.number(),
})

const entitySchema = v.object({
  id: v.string(),
  bankId: v.string(),
  name: v.string(),
  entityType: entityTypeSchema,
  description: v.nullable(v.string()),
  metadata: v.nullable(v.record(v.string(), v.unknown())),
  firstSeen: v.number(),
  lastUpdated: v.number(),
})

const scoredMemorySchema = v.object({
  memory: memoryUnitSchema,
  score: v.number(),
  sources: v.array(v.picklist([`semantic`, `fulltext`, `graph`, `temporal`])),
  entities: v.array(entitySchema),
})

const bankSchema = v.object({
  id: v.string(),
  name: v.string(),
  description: v.nullable(v.string()),
  config: bankConfigSchema,
  disposition: dispositionTraitsSchema,
  mission: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
})

const linkSchema = v.object({
  sourceId: v.string(),
  targetId: v.string(),
  linkType: linkTypeSchema,
})

// ── Input schemas ──

const createBankInputSchema = v.object({
  name: v.string(),
  description: v.optional(v.string()),
  config: v.optional(bankConfigSchema),
  disposition: v.optional(v.partial(dispositionTraitsSchema)),
  mission: v.optional(v.string()),
})

const updateBankInputSchema = v.partial(bankSchema)

const retainInputSchema = v.object({
  content: v.string(),
  options: v.optional(v.object({
    facts: v.optional(v.array(v.object({
      content: v.string(),
      factType: v.optional(factTypeSchema),
      confidence: v.optional(v.number()),
      occurredStart: v.optional(v.nullable(v.number())),
      occurredEnd: v.optional(v.nullable(v.number())),
      entities: v.optional(v.array(v.string())),
      tags: v.optional(v.array(v.string())),
    }))),
    metadata: v.optional(v.record(v.string(), v.unknown())),
    tags: v.optional(v.array(v.string())),
    context: v.optional(v.string()),
    eventDate: v.optional(v.union([v.number(), v.string()])),
    documentId: v.optional(v.string()),
    mode: v.optional(v.picklist([`concise`, `verbose`, `custom`])),
    customGuidelines: v.optional(v.string()),
    dedupThreshold: v.optional(v.number()),
    consolidate: v.optional(v.boolean()),
  })),
})

const retainBatchItemSchema = v.object({
  content: v.union([v.string(), v.array(v.object({ role: v.string(), content: v.string() }))]),
  context: v.optional(v.string()),
  eventDate: v.optional(v.union([v.number(), v.string()])),
  documentId: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  metadata: v.optional(v.record(v.string(), v.unknown())),
})

const retainBatchInputSchema = v.object({
  contents: v.array(v.union([v.string(), retainBatchItemSchema])),
  options: v.optional(v.object({
    metadata: v.optional(v.record(v.string(), v.unknown())),
    tags: v.optional(v.array(v.string())),
    context: v.optional(v.string()),
    eventDate: v.optional(v.union([v.number(), v.string()])),
    documentId: v.optional(v.string()),
    mode: v.optional(v.picklist([`concise`, `verbose`, `custom`])),
    customGuidelines: v.optional(v.string()),
    dedupThreshold: v.optional(v.number()),
    consolidate: v.optional(v.boolean()),
  })),
})

const recallInputSchema = v.object({
  query: v.string(),
  options: v.optional(v.object({
    limit: v.optional(v.number()),
    maxTokens: v.optional(v.number()),
    minConfidence: v.optional(v.number()),
    factTypes: v.optional(v.array(factTypeSchema)),
    entities: v.optional(v.array(v.string())),
    timeRange: v.optional(v.object({
      from: v.optional(v.number()),
      to: v.optional(v.number()),
    })),
    methods: v.optional(v.array(v.picklist([`semantic`, `fulltext`, `graph`, `temporal`]))),
    tags: v.optional(v.array(v.string())),
    tagsMatch: v.optional(tagsMatchSchema),
    includeEntities: v.optional(v.boolean()),
    maxEntityTokens: v.optional(v.number()),
    includeChunks: v.optional(v.boolean()),
    maxChunkTokens: v.optional(v.number()),
    enableTrace: v.optional(v.boolean()),
  })),
})

const reflectInputSchema = v.object({
  query: v.string(),
  options: v.optional(v.object({
    maxIterations: v.optional(v.number()),
    saveObservations: v.optional(v.boolean()),
    context: v.optional(v.string()),
    budget: v.optional(reflectBudgetSchema),
    tags: v.optional(v.array(v.string())),
    tagsMatch: v.optional(tagsMatchSchema),
    responseSchema: v.optional(v.record(v.string(), v.unknown())),
  })),
})

const listMemoryUnitsInputSchema = v.object({
  limit: v.optional(v.number()),
  offset: v.optional(v.number()),
  factType: v.optional(factTypeSchema),
  searchQuery: v.optional(v.string()),
})

const listEntitiesInputSchema = v.object({
  limit: v.optional(v.number()),
  offset: v.optional(v.number()),
})

// ── Output schemas ──

const retainResultSchema = v.object({
  memories: v.array(memoryUnitSchema),
  entities: v.array(entitySchema),
  links: v.array(linkSchema),
})

const recallResultSchema = v.object({
  memories: v.array(scoredMemorySchema),
  query: v.string(),
  entities: v.optional(v.record(v.string(), v.object({
    id: v.string(),
    name: v.string(),
    entityType: entityTypeSchema,
    memoryIds: v.array(v.string()),
  }))),
  chunks: v.optional(v.record(v.string(), v.object({
    chunkId: v.string(),
    memoryId: v.string(),
    documentId: v.nullable(v.string()),
    chunkIndex: v.nullable(v.number()),
    content: v.string(),
    truncated: v.boolean(),
  }))),
  trace: v.optional(v.any()),
})

const reflectResultSchema = v.object({
  answer: v.string(),
  memories: v.array(scoredMemorySchema),
  observations: v.array(v.string()),
  structuredOutput: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
  trace: v.optional(v.any()),
})

const bankStatsSchema = v.object({
  bankId: v.string(),
  nodeCounts: v.record(v.string(), v.number()),
  linkCounts: v.record(v.string(), v.number()),
  linkCountsByFactType: v.record(v.string(), v.number()),
  linkBreakdown: v.array(v.object({
    factType: v.string(),
    linkType: v.string(),
    count: v.number(),
  })),
  operations: v.record(v.string(), v.number()),
})

const memoryUnitListItemSchema = v.object({
  id: v.string(),
  text: v.string(),
  context: v.string(),
  date: v.string(),
  factType: factTypeSchema,
  mentionedAt: v.nullable(v.string()),
  occurredStart: v.nullable(v.string()),
  occurredEnd: v.nullable(v.string()),
  entities: v.string(),
  chunkId: v.nullable(v.string()),
})

const listMemoryUnitsResultSchema = v.object({
  items: v.array(memoryUnitListItemSchema),
  total: v.number(),
  limit: v.number(),
  offset: v.number(),
})

const memoryUnitDetailSchema = v.object({
  id: v.string(),
  text: v.string(),
  context: v.string(),
  date: v.string(),
  type: factTypeSchema,
  mentionedAt: v.nullable(v.string()),
  occurredStart: v.nullable(v.string()),
  occurredEnd: v.nullable(v.string()),
  entities: v.array(v.string()),
  documentId: v.nullable(v.string()),
  chunkId: v.nullable(v.string()),
  tags: v.array(v.string()),
  sourceMemoryIds: v.optional(v.array(v.string())),
  sourceMemories: v.optional(v.array(v.object({
    id: v.string(),
    text: v.string(),
    type: factTypeSchema,
    context: v.nullable(v.string()),
    occurredStart: v.nullable(v.string()),
    mentionedAt: v.nullable(v.string()),
  }))),
})

const deleteMemoryUnitResultSchema = v.object({
  success: v.boolean(),
  unitId: v.nullable(v.string()),
  message: v.string(),
})

const entityListItemSchema = v.object({
  id: v.string(),
  canonicalName: v.string(),
  mentionCount: v.number(),
  firstSeen: v.nullable(v.string()),
  lastSeen: v.nullable(v.string()),
  metadata: v.record(v.string(), v.unknown()),
})

const listEntitiesResultSchema = v.object({
  items: v.array(entityListItemSchema),
  total: v.number(),
  limit: v.number(),
  offset: v.number(),
})

const entityDetailSchema = v.object({
  id: v.string(),
  canonicalName: v.string(),
  description: v.nullable(v.string()),
  mentionCount: v.number(),
  firstSeen: v.nullable(v.string()),
  lastSeen: v.nullable(v.string()),
  metadata: v.record(v.string(), v.unknown()),
  observations: v.array(v.record(v.string(), v.unknown())),
})

const voidSchema = v.undefined_()
const listBanksOutputSchema = v.array(bankSchema)
const retainBatchOutputSchema = v.array(retainResultSchema)

// ============================================================================
// Router Type
// ============================================================================

export type AppRouter = {
  // Streams
  chat: StreamDef<`/chat/:chatId`, { messages: CollectionDef<typeof messageSchema> }>
  agent: StreamDef<`/agent/:chatId`, { messages: CollectionDef<typeof agentMessageSchema> }>
  agentEvents: StreamDef<`/agent/:chatId/events/:runId`, { events: CollectionDef<typeof agentEventSchema> }>
  // Bank CRUD
  createBank: ProcedureDef<`/banks`, typeof createBankInputSchema, typeof bankSchema, "POST">
  listBanks: ProcedureDef<`/banks`, typeof voidSchema, typeof listBanksOutputSchema, "GET">
  getBank: ProcedureDef<`/banks/:bankId`, typeof voidSchema, typeof bankSchema, "GET">
  updateBank: ProcedureDef<`/banks/:bankId`, typeof updateBankInputSchema, typeof bankSchema, "PATCH">
  deleteBank: ProcedureDef<`/banks/:bankId`, typeof voidSchema, typeof voidSchema, "DELETE">
  // Core operations
  retain: ProcedureDef<`/banks/:bankId/retain`, typeof retainInputSchema, typeof retainResultSchema, "POST">
  retainBatch: ProcedureDef<`/banks/:bankId/retain-batch`, typeof retainBatchInputSchema, typeof retainBatchOutputSchema, "POST">
  recall: ProcedureDef<`/banks/:bankId/recall`, typeof recallInputSchema, typeof recallResultSchema, "POST">
  reflect: ProcedureDef<`/banks/:bankId/reflect`, typeof reflectInputSchema, typeof reflectResultSchema, "POST">
  // Stats, memories, entities
  getBankStats: ProcedureDef<`/banks/:bankId/stats`, typeof voidSchema, typeof bankStatsSchema, "GET">
  listMemoryUnits: ProcedureDef<`/banks/:bankId/memories`, typeof listMemoryUnitsInputSchema, typeof listMemoryUnitsResultSchema, "GET">
  getMemoryUnit: ProcedureDef<`/banks/:bankId/memories/:memoryId`, typeof voidSchema, typeof memoryUnitDetailSchema, "GET">
  deleteMemoryUnit: ProcedureDef<`/banks/:bankId/memories/:memoryId`, typeof voidSchema, typeof deleteMemoryUnitResultSchema, "DELETE">
  listEntities: ProcedureDef<`/banks/:bankId/entities`, typeof listEntitiesInputSchema, typeof listEntitiesResultSchema, "GET">
  getEntity: ProcedureDef<`/banks/:bankId/entities/:entityId`, typeof voidSchema, typeof entityDetailSchema, "GET">
}

export const appRouter: Router<AppRouter> = createRouter()
  // ── Streams ──
  .stream(`chat`, `/chat/:chatId`, {
    messages: messageSchema,
  })
  .stream(`agent`, `/agent/:chatId`, {
    messages: agentMessageSchema,
  })
  .stream(`agentEvents`, `/agent/:chatId/events/:runId`, {
    events: agentEventSchema,
  })
  // ── Hindsight: Bank CRUD ──
  .post(`createBank`, `/banks`, { input: createBankInputSchema, output: bankSchema })
  .get(`listBanks`, `/banks`, { input: voidSchema, output: listBanksOutputSchema })
  .get(`getBank`, `/banks/:bankId`, { input: voidSchema, output: bankSchema })
  .patch(`updateBank`, `/banks/:bankId`, { input: updateBankInputSchema, output: bankSchema })
  .delete(`deleteBank`, `/banks/:bankId`, { input: voidSchema, output: voidSchema })
  // ── Hindsight: Core operations ──
  .post(`retain`, `/banks/:bankId/retain`, { input: retainInputSchema, output: retainResultSchema })
  .post(`retainBatch`, `/banks/:bankId/retain-batch`, { input: retainBatchInputSchema, output: retainBatchOutputSchema })
  .post(`recall`, `/banks/:bankId/recall`, { input: recallInputSchema, output: recallResultSchema })
  .post(`reflect`, `/banks/:bankId/reflect`, { input: reflectInputSchema, output: reflectResultSchema })
  // ── Hindsight: Stats, memories, entities ──
  .get(`getBankStats`, `/banks/:bankId/stats`, { input: voidSchema, output: bankStatsSchema })
  .get(`listMemoryUnits`, `/banks/:bankId/memories`, { input: listMemoryUnitsInputSchema, output: listMemoryUnitsResultSchema })
  .get(`getMemoryUnit`, `/banks/:bankId/memories/:memoryId`, { input: voidSchema, output: memoryUnitDetailSchema })
  .delete(`deleteMemoryUnit`, `/banks/:bankId/memories/:memoryId`, { input: voidSchema, output: deleteMemoryUnitResultSchema })
  .get(`listEntities`, `/banks/:bankId/entities`, { input: listEntitiesInputSchema, output: listEntitiesResultSchema })
  .get(`getEntity`, `/banks/:bankId/entities/:entityId`, { input: voidSchema, output: entityDetailSchema })
