import type { AnyTextAdapter } from "@tanstack/ai"

// ── Enums ──────────────────────────────────────────────────────────────────

/** Fact types following the biomimetic memory model */
export type FactType = "world" | "experience" | "opinion" | "observation"

/** Entity types */
export type EntityType =
  | "person"
  | "organization"
  | "place"
  | "concept"
  | "other"

/** Relationship types between memories */
export type LinkType =
  | "temporal"
  | "semantic"
  | "entity"
  | "causes"
  | "caused_by"
  | "enables"
  | "prevents"

// ── Meta-Path Graph Retrieval ─────────────────────────────────────────────

/** Direction constraint for a meta-path step */
export type LinkDirection = "forward" | "backward" | "both"

/** A single step in a meta-path: which link type to traverse and in which direction */
export interface MetaPathStep {
  /** Link type to traverse in this step */
  linkType: LinkType
  /** Direction: "forward" = sourceId→targetId, "backward" = reverse, "both" = either */
  direction: LinkDirection
  /** Score decay factor for this step (0-1). Applied multiplicatively. Default: 0.5 */
  decay?: number
}

/** A complete meta-path: a named sequence of typed steps */
export interface MetaPath {
  /** Human-readable name for debugging/tracing */
  name: string
  /** Ordered sequence of link types to traverse */
  steps: MetaPathStep[]
  /** Weight of this meta-path's contribution when aggregating across paths. Default: 1.0 */
  weight?: number
}

// ── Data objects ───────────────────────────────────────────────────────────

/** A change entry in an observation's history */
export interface ObservationHistoryEntry {
  previousText: string
  changedAt: number
  reason: string
  sourceMemoryId: string
}

/** A memory unit (extracted fact) */
export interface MemoryUnit {
  id: string
  bankId: string
  content: string
  factType: FactType
  confidence: number
  documentId: string | null
  chunkId: string | null
  validFrom: number | null
  validTo: number | null
  /** Epoch ms when content was mentioned in source context (nullable). */
  mentionedAt: number | null
  metadata: Record<string, unknown> | null
  tags: string[] | null
  sourceText: string | null
  consolidatedAt: number | null
  /** For observations: number of supporting source memories */
  proofCount: number
  /** For observations: IDs of memories used to generate this observation */
  sourceMemoryIds: string[] | null
  /** For observations: change history */
  history: ObservationHistoryEntry[] | null
  createdAt: number
  updatedAt: number
}

/** A named entity */
export interface Entity {
  id: string
  bankId: string
  name: string
  entityType: EntityType
  description: string | null
  metadata: Record<string, unknown> | null
  firstSeen: number
  lastUpdated: number
}

/** A memory with retrieval score and provenance */
export interface ScoredMemory {
  memory: MemoryUnit
  score: number
  sources: Array<"semantic" | "fulltext" | "graph" | "temporal">
  entities: Entity[]
}

/** Per-bank behavioral overrides (stored as JSON in hs_banks.config) */
export interface BankConfig {
  /** Extraction mode for retain(). Default: "concise" */
  extractionMode?: "concise" | "verbose" | "custom"
  /** Custom extraction guidelines (used when extractionMode is "custom") */
  customGuidelines?: string | null
  /** Enable auto-consolidation after retain. Default: true */
  enableConsolidation?: boolean
  /** Reflect exploration depth. Default: "mid" */
  reflectBudget?: ReflectBudget
  /** Deduplication similarity threshold (0-1). Default: 0.92 */
  dedupThreshold?: number
}

/** Personality traits that shape reflect behavior (1-5 integer scale) */
export interface DispositionTraits {
  /** How skeptical vs trusting (1=trusting, 5=skeptical) */
  skepticism: number
  /** How literally to interpret information (1=flexible, 5=literal) */
  literalism: number
  /** How much to consider emotional context (1=detached, 5=empathetic) */
  empathy: number
}

/** A memory bank (agent profile) */
export interface Bank {
  id: string
  name: string
  description: string | null
  config: BankConfig
  /** Personality traits shaping reflect behavior. Default: all 3s (neutral) */
  disposition: DispositionTraits
  /** First-person mission statement ("I am...") that shapes reflect behavior */
  mission: string
  createdAt: number
  updatedAt: number
}

/** A mental model (user-curated summary with freshness) */
export interface MentalModel {
  id: string
  bankId: string
  name: string
  sourceQuery: string
  content: string | null
  sourceMemoryIds: string[] | null
  tags: string[] | null
  autoRefresh: boolean
  lastRefreshedAt: number | null
  createdAt: number
  updatedAt: number
}

// ── Configuration ──────────────────────────────────────────────────────────

/** User-provided embedding function: text → float array */
export type EmbedFunction = (text: string) => Promise<number[]>
/** Optional user-provided embedding batch function: texts → float arrays */
export type EmbedBatchFunction = (texts: string[]) => Promise<number[][]>

/** User-provided reranking function: (query, documents) → relevance scores (higher = more relevant) */
export type RerankFunction = (query: string, documents: string[]) => Promise<number[]>

/** Configuration for creating a Hindsight instance */
export interface HindsightConfig {
  /** Path to SQLite database file */
  dbPath: string
  /** TanStack AI text adapter for LLM calls. Default: anthropicText("claude-haiku-4-5") */
  adapter?: AnyTextAdapter
  /** Embedding function: text → float array (user-provided) */
  embed: EmbedFunction
  /** Optional embedding batch function for high-throughput ingestion */
  embedBatch?: EmbedBatchFunction
  /** Embedding dimensions (must match embed output). Default: 1536 */
  embeddingDimensions?: number
  /** Enable automatic consolidation after retain. Default: true */
  enableConsolidation?: boolean
  /** Default bank config applied to all banks unless overridden per-bank */
  defaults?: BankConfig
  /** Optional cross-encoder reranking function for improved recall precision */
  rerank?: RerankFunction
  /** Called after each operation completes with timing + metadata */
  onTrace?: TraceCallback
  /** Optional auth/tenant/operation validator extension hooks. */
  extensions?: HindsightExtensions
}

// ── Tracing ───────────────────────────────────────────────────────────────

/** Trace emitted after each core operation completes */
export interface HindsightTrace {
  operation: "retain" | "recall" | "reflect" | "consolidate"
  bankId: string
  startedAt: number
  duration: number
  metadata: Record<string, unknown>
}

/** Callback for receiving operation traces */
export type TraceCallback = (trace: HindsightTrace) => void

export type HindsightOperationName =
  | "retain"
  | "retain_batch"
  | "recall"
  | "reflect"
  | "consolidate"
  | "submit_async_retain"
  | "submit_async_consolidation"
  | "submit_async_refresh_mental_model"

export interface HindsightOperationContext {
  operation: HindsightOperationName
  bankId: string
  tenantId: string
  input: Record<string, unknown>
}

export interface HindsightOperationResultContext
  extends HindsightOperationContext {
  success: boolean
  result?: unknown
  error?: string
}

export interface HindsightExtensions {
  /** Optional tenant resolver. Defaults to the bankId when not provided. */
  resolveTenantId?: (bankId: string) => string | undefined
  /** Optional auth hook called before operations run. */
  authorize?: (
    context: HindsightOperationContext,
  ) => void | Promise<void>
  /** Optional validator hook called before operations run. */
  validate?: (
    context: HindsightOperationContext,
  ) => void | Promise<void>
  /** Optional completion hook called after operation success/failure. */
  onComplete?: (
    context: HindsightOperationResultContext,
  ) => void | Promise<void>
}

// ── Operation options ──────────────────────────────────────────────────────

/** Options for retain() */
export interface RetainOptions {
  /** Provide pre-extracted facts (skips LLM extraction) */
  facts?: Array<{
    content: string
    factType?: FactType
    confidence?: number
    validFrom?: number | null
    validTo?: number | null
    entities?: string[]
    tags?: string[]
  }>
  /** Additional metadata to attach to all extracted memories */
  metadata?: Record<string, unknown>
  /** Tags to attach to all extracted memories */
  tags?: string[]
  /** Optional context attached to all extracted memories in this call. */
  context?: string
  /** Optional timestamp used as mentionedAt anchor (epoch ms, Date, or ISO string). */
  eventDate?: number | Date | string
  /** Optional document identifier for this retain call. */
  documentId?: string
  /** Extraction mode. Default: "concise" */
  mode?: "concise" | "verbose" | "custom"
  /** Custom extraction guidelines (only used when mode is "custom") */
  customGuidelines?: string
  /** Deduplication similarity threshold (0-1). Set to 0 to disable. Default: 0.92 */
  dedupThreshold?: number
  /** Trigger consolidation after retain. Default: true */
  consolidate?: boolean
}

/** Options for retainBatch() */
export interface RetainBatchOptions
  extends Omit<RetainOptions, "facts"> {}

/** Rich retain-batch item. */
export interface RetainBatchItem {
  content: string
  context?: string
  eventDate?: number | Date | string
  documentId?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

/** Options for recall() */
export interface RecallOptions {
  /** Maximum results to return. Default: 10 */
  limit?: number
  /** Optional token budget for returned memory content. */
  maxTokens?: number
  /** Minimum confidence threshold. Default: 0 */
  minConfidence?: number
  /** Filter by fact types */
  factTypes?: FactType[]
  /** Filter by entity names */
  entities?: string[]
  /** Time range filter (epoch ms) */
  timeRange?: { from?: number; to?: number }
  /** Which retrieval methods to use. Default: all */
  methods?: Array<"semantic" | "fulltext" | "graph" | "temporal">
  /** Filter by tags */
  tags?: string[]
  /** Tag matching mode. Default: "any" */
  tagsMatch?: TagsMatch
  /** Include aggregated entity states in the response. */
  includeEntities?: boolean
  /** Optional token budget for entity payload. */
  maxEntityTokens?: number
  /** Include chunk-style context payload in the response. */
  includeChunks?: boolean
  /** Optional token budget for chunk payload. */
  maxChunkTokens?: number
  /** Include detailed retrieval/ranking trace. */
  enableTrace?: boolean
}

/** Tag matching mode for recall/reflect tag filtering */
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict"

/** Budget controls how many iterations the reflect agent gets */
export type ReflectBudget = "low" | "mid" | "high"

/** Freshness classification for observations */
export type Freshness = "up_to_date" | "slightly_stale" | "stale"

/** Options for reflect() */
export interface ReflectOptions {
  /** Maximum agent loop iterations. Overrides budget if set. */
  maxIterations?: number
  /** Whether to save the answer as an observation. Default: true */
  saveObservations?: boolean
  /** Additional context to provide to the reflection agent */
  context?: string
  /** Budget controls exploration depth: low=3, mid=5, high=8 iterations. Default: "mid" */
  budget?: ReflectBudget
  /** Filter by tags (propagated to all tier searches) */
  tags?: string[]
  /** Tag matching mode. Default: "any" */
  tagsMatch?: TagsMatch
  /** Optional JSON schema for structured output extraction from the answer. */
  responseSchema?: Record<string, unknown>
}

// ── Results ────────────────────────────────────────────────────────────────

/** Result from retain() */
export interface RetainResult {
  memories: MemoryUnit[]
  entities: Entity[]
  links: Array<{ sourceId: string; targetId: string; linkType: LinkType }>
}

/** Result from retainBatch(): one RetainResult per input content item */
export type RetainBatchResult = RetainResult[]

/** Result from recall() */
export interface RecallResult {
  memories: ScoredMemory[]
  query: string
  entities?: Record<string, RecallEntityState>
  chunks?: Record<string, RecallChunk>
  trace?: RecallTrace
}

export interface RecallTraceMetric {
  phaseName: string
  durationMs: number
  details?: Record<string, unknown>
}

export interface RecallTraceMethodResult {
  methodName: "semantic" | "fulltext" | "graph" | "temporal"
  durationMs: number
  count: number
  results: Array<{
    id: string
    rank: number
    score: number
  }>
}

export interface RecallTraceCandidate {
  id: string
  rank: number
  sources: Array<"semantic" | "fulltext" | "graph" | "temporal">
  rrfScore: number
  crossEncoderScoreNormalized: number
  rrfNormalized: number
  temporal: number
  recency: number
  combinedScore: number
}

export interface RecallTrace {
  startedAt: number
  query: string
  maxTokens: number | null
  temporalConstraint?: { from?: number; to?: number }
  retrieval: RecallTraceMethodResult[]
  phaseMetrics: RecallTraceMetric[]
  candidates: RecallTraceCandidate[]
  selectedMemoryIds: string[]
  totalDurationMs: number
}

/** Aggregated entity state payload returned by recall(includeEntities=true). */
export interface RecallEntityState {
  id: string
  name: string
  entityType: EntityType
  memoryIds: string[]
}

/** Lightweight chunk payload returned by recall(includeChunks=true). */
export interface RecallChunk {
  chunkId: string
  memoryId: string
  documentId: string | null
  chunkIndex: number | null
  content: string
  truncated: boolean
}

export interface DocumentRecord {
  id: string
  bankId: string
  contentHash: string | null
  textLength: number
  metadata: Record<string, unknown> | null
  retainParams: Record<string, unknown> | null
  tags: string[]
  createdAt: number
  updatedAt: number
}

export interface ChunkRecord {
  id: string
  documentId: string
  bankId: string
  index: number
  text: string
  createdAt: number
}

export interface GraphNode {
  id: string
  content: string
  factType: FactType
  documentId: string | null
  chunkId: string | null
  tags: string[]
  sourceMemoryIds: string[]
}

export interface GraphEdge {
  sourceId: string
  targetId: string
  linkType: LinkType
  weight: number
}

export interface MemoryUnitListItem {
  id: string
  text: string
  context: string
  date: string
  factType: FactType
  mentionedAt: string | null
  occurredStart: string | null
  occurredEnd: string | null
  entities: string
  chunkId: string | null
}

export interface ListMemoryUnitsOptions {
  factType?: FactType
  searchQuery?: string
  limit?: number
  offset?: number
}

export interface ListMemoryUnitsResult {
  items: MemoryUnitListItem[]
  total: number
  limit: number
  offset: number
}

export interface MemoryUnitSourceMemory {
  id: string
  text: string
  type: FactType
  context: string | null
  occurredStart: string | null
  mentionedAt: string | null
}

export interface MemoryUnitDetail {
  id: string
  text: string
  context: string
  date: string
  type: FactType
  mentionedAt: string | null
  occurredStart: string | null
  occurredEnd: string | null
  entities: string[]
  documentId: string | null
  chunkId: string | null
  tags: string[]
  sourceMemoryIds?: string[]
  sourceMemories?: MemoryUnitSourceMemory[]
}

export interface DeleteMemoryUnitResult {
  success: boolean
  unitId: string | null
  message: string
}

export interface ClearObservationsResult {
  deletedCount: number
}

export interface EntityListItem {
  id: string
  canonicalName: string
  mentionCount: number
  firstSeen: string | null
  lastSeen: string | null
  metadata: Record<string, unknown>
}

export interface ListEntitiesResult {
  items: EntityListItem[]
  total: number
  limit: number
  offset: number
}

export interface EntityState {
  entityId: string
  canonicalName: string
  observations: Array<Record<string, unknown>>
}

export interface EntityDetail {
  id: string
  canonicalName: string
  mentionCount: number
  firstSeen: string | null
  lastSeen: string | null
  metadata: Record<string, unknown>
  observations: Array<Record<string, unknown>>
}

export interface TagUsage {
  tag: string
  count: number
}

export interface ListTagsOptions {
  pattern?: string
  limit?: number
  offset?: number
}

export interface ListTagsResult {
  items: TagUsage[]
  total: number
  limit: number
  offset: number
}

export interface BankStats {
  bankId: string
  nodeCounts: Record<string, number>
  linkCounts: Record<string, number>
  linkCountsByFactType: Record<string, number>
  linkBreakdown: Array<{ factType: string; linkType: string; count: number }>
  operations: Record<string, number>
}

// ── Async Operations ─────────────────────────────────────────────────────

export type AsyncOperationType =
  | "retain"
  | "consolidation"
  | "refresh_mental_model"

export type AsyncOperationStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"

export type AsyncOperationApiStatus =
  | "pending"
  | "completed"
  | "failed"
  | "not_found"

export interface AsyncOperationSummary {
  id: string
  taskType: AsyncOperationType
  itemsCount: number
  documentId: string | null
  createdAt: number
  status: Exclude<AsyncOperationApiStatus, "not_found">
  errorMessage: string | null
}

export interface ListOperationsOptions {
  status?: Exclude<AsyncOperationApiStatus, "not_found">
  limit?: number
  offset?: number
}

export interface ListOperationsResult {
  total: number
  operations: AsyncOperationSummary[]
}

export interface OperationStatusResult {
  operationId: string
  status: AsyncOperationApiStatus
  operationType: AsyncOperationType | null
  createdAt: number | null
  updatedAt: number | null
  completedAt: number | null
  errorMessage: string | null
  resultMetadata: Record<string, unknown> | null
}

export interface SubmitAsyncOperationResult {
  operationId: string
  deduplicated?: boolean
}

export interface SubmitAsyncRetainResult extends SubmitAsyncOperationResult {
  itemsCount: number
}

export interface CancelOperationResult {
  success: boolean
  message: string
  operationId: string
  bankId: string
}

/** Result from reflect() */
export interface ReflectResult {
  answer: string
  memories: ScoredMemory[]
  observations: string[]
  structuredOutput?: Record<string, unknown> | null
  trace?: {
    startedAt: number
    durationMs: number
    toolCalls: Array<{
      tool: string
      durationMs: number
      input: Record<string, unknown>
      outputSize: number
      error?: string
    }>
  }
}

// ── Consolidation options/results ────────────────────────────────────────

/** Options for consolidate() */
export interface ConsolidateOptions {
  /** Maximum memories to process per batch. Default: 50 */
  batchSize?: number
  /** Maximum tokens for recalling related observations. Default: 1024 */
  maxRecallTokens?: number
  /** Whether to trigger mental model refreshes after consolidation. Default: true */
  refreshMentalModels?: boolean
}

/** Result from consolidate() */
export interface ConsolidateResult {
  /** Number of memories processed */
  memoriesProcessed: number
  /** Number of new observations created */
  observationsCreated: number
  /** Number of existing observations updated */
  observationsUpdated: number
  /** Number of observations merged into a single observation */
  observationsMerged: number
  /** Number of memories skipped during consolidation */
  skipped: number
  /** Number of mental model refreshes queued (fire-and-forget) */
  mentalModelsRefreshQueued: number
}

/** A single LLM-decided consolidation action */
export type ConsolidationAction =
  | { action: "create"; text: string; reason: string }
  | { action: "update"; observationId: string; text: string; reason: string }
  | {
      action: "merge"
      observationIds: string[]
      text: string
      reason: string
    }
  | { action: "skip"; reason?: string }

// ── Mental Model options/results ──────────────────────────────────────────

/** Options for creating a mental model */
export interface CreateMentalModelOptions {
  /** Human-readable name */
  name: string
  /** The query to run through reflect() when refreshing */
  sourceQuery: string
  /** Optional initial content (skips needing a refresh) */
  content?: string
  /** Tags for scoping */
  tags?: string[]
  /** Auto-refresh when new memories are retained. Default: false */
  autoRefresh?: boolean
}

/** Options for updating a mental model */
export interface UpdateMentalModelOptions {
  name?: string
  sourceQuery?: string
  content?: string
  tags?: string[]
  autoRefresh?: boolean
}

/** Result from refreshing a mental model */
export interface RefreshMentalModelResult {
  model: MentalModel
  reflectResult: ReflectResult
}

// ── Directives ────────────────────────────────────────────────────────────

/** A behavioral directive (hard rule for reflect) */
export interface Directive {
  id: string
  bankId: string
  name: string
  content: string
  priority: number
  isActive: boolean
  tags: string[] | null
  createdAt: number
  updatedAt: number
}

/** Options for creating a directive */
export interface CreateDirectiveOptions {
  name: string
  content: string
  priority?: number
  isActive?: boolean
  tags?: string[]
}

/** Options for updating a directive */
export interface UpdateDirectiveOptions {
  name?: string
  content?: string
  priority?: number
  isActive?: boolean
  tags?: string[] | null
}

// ── Reflect 3-tier result types ─────────────────────────────────────────

/** Return shape from search_mental_models tool (Tier 1) */
export interface MentalModelSearchResult {
  id: string
  name: string
  content: string
  tags: string[] | null
  relevanceScore: number
  updatedAt: number
  isStale: boolean
}

/** Return shape from search_observations tool (Tier 2) */
export interface ObservationSearchResult {
  id: string
  content: string
  proofCount: number
  sourceMemoryIds: string[]
  tags: string[] | null
  score: number
  isStale: boolean
  stalenessReason: string | null
  freshness: Freshness
}

/** Return shape from search_memories / raw facts tool (Tier 3) */
export interface RawFactSearchResult {
  id: string
  content: string
  factType: FactType
  entities: string[]
  score: number
  occurredAt: number | null
}
