/**
 * Valibot schemas for Hindsight RPC procedures.
 *
 * Single source of truth for all Hindsight data shapes.
 * TypeScript types are inferred from schemas via `v.InferOutput`.
 *
 * Lives in `@ellie/schemas` so both `@ellie/router` and `@ellie/hindsight`
 * can import these without circular dependencies.
 */
import * as v from "valibot"

// ============================================================================
// Enum Schemas
// ============================================================================

export const factTypeSchema = v.picklist([`world`, `experience`, `opinion`, `observation`])
export type FactType = v.InferOutput<typeof factTypeSchema>

export const entityTypeSchema = v.picklist([`person`, `organization`, `place`, `concept`, `other`])
export type EntityType = v.InferOutput<typeof entityTypeSchema>

export const linkTypeSchema = v.picklist([
  `temporal`, `semantic`, `entity`, `causes`, `caused_by`, `enables`, `prevents`,
])
export type LinkType = v.InferOutput<typeof linkTypeSchema>

export const tagsMatchSchema = v.picklist([`any`, `all`, `any_strict`, `all_strict`])
export type TagsMatch = v.InferOutput<typeof tagsMatchSchema>

export const reflectBudgetSchema = v.picklist([`low`, `mid`, `high`])
export type ReflectBudget = v.InferOutput<typeof reflectBudgetSchema>

export const freshnessSchema = v.picklist([`up_to_date`, `slightly_stale`, `stale`])
export type Freshness = v.InferOutput<typeof freshnessSchema>

// ============================================================================
// Data Object Schemas
// ============================================================================

export const dispositionTraitsSchema = v.object({
  skepticism: v.number(),
  literalism: v.number(),
  empathy: v.number(),
})
export type DispositionTraits = v.InferOutput<typeof dispositionTraitsSchema>

export const bankConfigSchema = v.object({
  extractionMode: v.optional(v.picklist([`concise`, `verbose`, `custom`])),
  customGuidelines: v.optional(v.nullable(v.string())),
  enableConsolidation: v.optional(v.boolean()),
  reflectBudget: v.optional(reflectBudgetSchema),
  dedupThreshold: v.optional(v.number()),
})
export type BankConfig = v.InferOutput<typeof bankConfigSchema>

export const observationHistoryEntrySchema = v.object({
  previousText: v.string(),
  changedAt: v.number(),
  reason: v.string(),
  sourceMemoryId: v.string(),
})
export type ObservationHistoryEntry = v.InferOutput<typeof observationHistoryEntrySchema>

export const memoryUnitSchema = v.object({
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
export type MemoryUnit = v.InferOutput<typeof memoryUnitSchema>

export const entitySchema = v.object({
  id: v.string(),
  bankId: v.string(),
  name: v.string(),
  entityType: entityTypeSchema,
  description: v.nullable(v.string()),
  metadata: v.nullable(v.record(v.string(), v.unknown())),
  firstSeen: v.number(),
  lastUpdated: v.number(),
})
export type Entity = v.InferOutput<typeof entitySchema>

export const scoredMemorySchema = v.object({
  memory: memoryUnitSchema,
  score: v.number(),
  sources: v.array(v.picklist([`semantic`, `fulltext`, `graph`, `temporal`])),
  entities: v.array(entitySchema),
})
export type ScoredMemory = v.InferOutput<typeof scoredMemorySchema>

export const bankSchema = v.object({
  id: v.string(),
  name: v.string(),
  description: v.nullable(v.string()),
  config: bankConfigSchema,
  disposition: dispositionTraitsSchema,
  mission: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type Bank = v.InferOutput<typeof bankSchema>

export const linkSchema = v.object({
  sourceId: v.string(),
  targetId: v.string(),
  linkType: linkTypeSchema,
})

// ============================================================================
// Input Schemas
// ============================================================================

export const createBankInputSchema = v.object({
  name: v.string(),
  description: v.optional(v.string()),
  config: v.optional(bankConfigSchema),
  disposition: v.optional(v.partial(dispositionTraitsSchema)),
  mission: v.optional(v.string()),
})

export const updateBankInputSchema = v.partial(bankSchema)

export const retainInputSchema = v.object({
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
    profile: v.optional(v.string()),
    project: v.optional(v.string()),
    session: v.optional(v.string()),
  })),
})

export const retainBatchItemSchema = v.object({
  content: v.union([v.string(), v.array(v.object({ role: v.string(), content: v.string() }))]),
  context: v.optional(v.string()),
  eventDate: v.optional(v.union([v.number(), v.string()])),
  documentId: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  metadata: v.optional(v.record(v.string(), v.unknown())),
})

export const retainBatchInputSchema = v.object({
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
    profile: v.optional(v.string()),
    project: v.optional(v.string()),
    session: v.optional(v.string()),
  })),
})

export const recallModeSchema = v.picklist([`hybrid`, `cognitive`])
export type RecallMode = v.InferOutput<typeof recallModeSchema>

export const recallInputSchema = v.object({
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
    mode: v.optional(recallModeSchema),
    sessionId: v.optional(v.string()),
  })),
})

export const reflectInputSchema = v.object({
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

export const listMemoryUnitsInputSchema = v.object({
  limit: v.optional(v.number()),
  offset: v.optional(v.number()),
  factType: v.optional(factTypeSchema),
  searchQuery: v.optional(v.string()),
})
export type ListMemoryUnitsOptions = v.InferOutput<typeof listMemoryUnitsInputSchema>

export const listEntitiesInputSchema = v.object({
  limit: v.optional(v.number()),
  offset: v.optional(v.number()),
})

// ============================================================================
// Output Schemas
// ============================================================================

export const retainResultSchema = v.object({
  memories: v.array(memoryUnitSchema),
  entities: v.array(entitySchema),
  links: v.array(linkSchema),
})
export type RetainResult = v.InferOutput<typeof retainResultSchema>

export const recallResultSchema = v.object({
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
export type RecallResult = v.InferOutput<typeof recallResultSchema>

export const reflectResultSchema = v.object({
  answer: v.string(),
  memories: v.array(scoredMemorySchema),
  observations: v.array(v.string()),
  structuredOutput: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
  trace: v.optional(v.any()),
})
export type ReflectResult = v.InferOutput<typeof reflectResultSchema>

export const bankStatsSchema = v.object({
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
export type BankStats = v.InferOutput<typeof bankStatsSchema>

export const memoryUnitListItemSchema = v.object({
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
export type MemoryUnitListItem = v.InferOutput<typeof memoryUnitListItemSchema>

export const listMemoryUnitsResultSchema = v.object({
  items: v.array(memoryUnitListItemSchema),
  total: v.number(),
  limit: v.number(),
  offset: v.number(),
})
export type ListMemoryUnitsResult = v.InferOutput<typeof listMemoryUnitsResultSchema>

export const memoryUnitSourceMemorySchema = v.object({
  id: v.string(),
  text: v.string(),
  type: factTypeSchema,
  context: v.nullable(v.string()),
  occurredStart: v.nullable(v.string()),
  mentionedAt: v.nullable(v.string()),
})
export type MemoryUnitSourceMemory = v.InferOutput<typeof memoryUnitSourceMemorySchema>

export const memoryUnitDetailSchema = v.object({
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
  sourceMemories: v.optional(v.array(memoryUnitSourceMemorySchema)),
})
export type MemoryUnitDetail = v.InferOutput<typeof memoryUnitDetailSchema>

export const deleteMemoryUnitResultSchema = v.object({
  success: v.boolean(),
  unitId: v.nullable(v.string()),
  message: v.string(),
})
export type DeleteMemoryUnitResult = v.InferOutput<typeof deleteMemoryUnitResultSchema>

export const entityListItemSchema = v.object({
  id: v.string(),
  canonicalName: v.string(),
  mentionCount: v.number(),
  firstSeen: v.nullable(v.string()),
  lastSeen: v.nullable(v.string()),
  metadata: v.record(v.string(), v.unknown()),
})
export type EntityListItem = v.InferOutput<typeof entityListItemSchema>

export const listEntitiesResultSchema = v.object({
  items: v.array(entityListItemSchema),
  total: v.number(),
  limit: v.number(),
  offset: v.number(),
})
export type ListEntitiesResult = v.InferOutput<typeof listEntitiesResultSchema>

export const entityDetailSchema = v.object({
  id: v.string(),
  canonicalName: v.string(),
  description: v.nullable(v.string()),
  mentionCount: v.number(),
  firstSeen: v.nullable(v.string()),
  lastSeen: v.nullable(v.string()),
  metadata: v.record(v.string(), v.unknown()),
  observations: v.array(v.record(v.string(), v.unknown())),
})
export type EntityDetail = v.InferOutput<typeof entityDetailSchema>

// ============================================================================
// Episode Schemas
// ============================================================================

export const retainRouteSchema = v.picklist([`reinforce`, `reconsolidate`, `new_trace`])
export type RetainRouteValue = v.InferOutput<typeof retainRouteSchema>

export const episodeBoundaryReasonSchema = v.picklist([`time_gap`, `scope_change`, `phrase_boundary`, `initial`])

export const episodeSummarySchema = v.object({
  episodeId: v.string(),
  startAt: v.number(),
  endAt: v.nullable(v.number()),
  lastEventAt: v.number(),
  eventCount: v.number(),
  boundaryReason: v.nullable(episodeBoundaryReasonSchema),
  profile: v.nullable(v.string()),
  project: v.nullable(v.string()),
  session: v.nullable(v.string()),
})
export type EpisodeSummaryValue = v.InferOutput<typeof episodeSummarySchema>

export const listEpisodesInputSchema = v.object({
  profile: v.optional(v.string()),
  project: v.optional(v.string()),
  session: v.optional(v.string()),
  limit: v.optional(v.number()),
  cursor: v.optional(v.string()),
})

export const listEpisodesResultSchema = v.object({
  items: v.array(episodeSummarySchema),
  total: v.number(),
  limit: v.number(),
  cursor: v.nullable(v.string()),
})

export const narrativeInputSchema = v.object({
  anchorMemoryId: v.string(),
  direction: v.optional(v.picklist([`before`, `after`, `both`])),
  steps: v.optional(v.number()),
})

export const narrativeEventSchema = v.object({
  memoryId: v.string(),
  episodeId: v.string(),
  eventTime: v.number(),
  route: retainRouteSchema,
  contentSnippet: v.string(),
})

export const narrativeResultSchema = v.object({
  events: v.array(narrativeEventSchema),
  anchorMemoryId: v.string(),
})

// ============================================================================
// Utility Schemas (used by router)
// ============================================================================

export const voidSchema = v.undefined_()
export const listBanksOutputSchema = v.array(bankSchema)
export const retainBatchOutputSchema = v.array(retainResultSchema)
