import type { AnyTextAdapter } from "@tanstack/ai"

// ============================================================================
// Schema-derived types (source of truth: ./schemas.ts)
// ============================================================================

export type {
  FactType,
  EntityType,
  LinkType,
  TagsMatch,
  ReflectBudget,
  Freshness,
  DispositionTraits,
  BankConfig,
  ObservationHistoryEntry,
  MemoryUnit,
  Entity,
  ScoredMemory,
  Bank,
  BankStats,
  MemoryUnitListItem,
  ListMemoryUnitsOptions,
  ListMemoryUnitsResult,
  MemoryUnitSourceMemory,
  MemoryUnitDetail,
  DeleteMemoryUnitResult,
  EntityListItem,
  ListEntitiesResult,
  EntityDetail,
  RetainResult,
} from "./schemas"

// ============================================================================
// Internal types (not part of the RPC schema surface)
// ============================================================================

/** Canonical transcript turn format for extraction parity with Python Hindsight. */
export interface TranscriptTurn {
  role: string
  content: string
}

/** Supported retain content input. */
export type RetainContentInput = string | TranscriptTurn[]

// ── Meta-Path Graph Retrieval ─────────────────────────────────────────────

/** Direction constraint for a meta-path step */
export type LinkDirection = "forward" | "backward" | "both"

/** A single step in a meta-path: which link type to traverse and in which direction */
export interface MetaPathStep {
  /** Link type to traverse in this step */
  linkType: import("./schemas").LinkType
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
  /**
   * Embedding function: text → float array (user-provided).
   *
   * Optional. If omitted, Hindsight uses the built-in TEI default targeting
   * BAAI/bge-small-en-v1.5.
   */
  embed?: EmbedFunction
  /**
   * Optional embedding batch function for high-throughput ingestion.
   *
   * If omitted while using built-in defaults, Hindsight uses the TEI batch endpoint.
   */
  embedBatch?: EmbedBatchFunction
  /**
   * Embedding dimensions (must match embed output).
   * Default: 1536 for custom embed functions, 384 for built-in TEI defaults.
   */
  embeddingDimensions?: number
  /** Enable automatic consolidation after retain. Default: true */
  enableConsolidation?: boolean
  /** Default bank config applied to all banks unless overridden per-bank */
  defaults?: import("./schemas").BankConfig
  /**
   * Optional cross-encoder reranking function for improved recall precision.
   *
   * If omitted while using built-in defaults, Hindsight uses the built-in TEI
   * reranker targeting cross-encoder/ms-marco-MiniLM-L-6-v2.
   */
  rerank?: RerankFunction
  /** Called after each operation completes with timing + metadata */
  onTrace?: TraceCallback
  /** Optional auth/tenant/operation validator extension hooks. */
  extensions?: HindsightExtensions
}

// ── Tracing ───────────────────────────────────────────────────────────────

/** Trace emitted after each core operation completes */
export interface HindsightTrace {
  operation: "retain" | "recall" | "reflect" | "consolidate" | "list_episodes" | "narrative"
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
  | "list_episodes"
  | "narrative"
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
    factType?: import("./schemas").FactType
    confidence?: number
    occurredStart?: number | null
    occurredEnd?: number | null
    entities?: string[]
    tags?: string[]
    /** Causal relations to other facts in this array (by index). */
    causalRelations?: Array<{
      targetIndex: number
      relationType?: string
      strength?: number
    }>
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
  /** Profile identifier for episode scoping */
  profile?: string
  /** Project identifier for episode scoping */
  project?: string
  /** Session identifier for episode scoping */
  session?: string
}

/** Options for retainBatch() */
export interface RetainBatchOptions
  extends Omit<RetainOptions, "facts"> {}

/** Rich retain-batch item. */
export interface RetainBatchItem {
  /** Plain text or transcript turns array ({ role, content }). */
  content: RetainContentInput
  context?: string
  eventDate?: number | Date | string
  documentId?: string
  tags?: string[]
  metadata?: Record<string, unknown>
  /** Profile identifier for episode scoping */
  profile?: string
  /** Project identifier for episode scoping */
  project?: string
  /** Session identifier for episode scoping */
  session?: string
}

/** Recall scoring mode: "hybrid" (default, unchanged) or "cognitive" (ACT-R inspired). */
export type RecallMode = "hybrid" | "cognitive"

/** Options for recall() */
export interface RecallOptions {
  /** Maximum results to return. Default: 10 */
  limit?: number
  /** Optional token budget for returned memory content. */
  maxTokens?: number
  /** Minimum confidence threshold. Default: 0 */
  minConfidence?: number
  /** Filter by fact types */
  factTypes?: import("./schemas").FactType[]
  /** Filter by entity names */
  entities?: string[]
  /** Time range filter (epoch ms) */
  timeRange?: { from?: number; to?: number }
  /** Which retrieval methods to use. Default: all */
  methods?: Array<"semantic" | "fulltext" | "graph" | "temporal">
  /** Filter by tags */
  tags?: string[]
  /** Tag matching mode. Default: "any" */
  tagsMatch?: import("./schemas").TagsMatch
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
  /** Scoring mode. Default: "hybrid" (unchanged behavior). "cognitive" uses ACT-R scoring. */
  mode?: RecallMode
  /** Session ID for working-memory boost effects (only used in "cognitive" mode). */
  sessionId?: string
}

/** Options for reflect() */
export interface ReflectOptions {
  /** Maximum agent loop iterations. Overrides budget if set. */
  maxIterations?: number
  /** Whether to save the answer as an observation. Default: true */
  saveObservations?: boolean
  /** Additional context to provide to the reflection agent */
  context?: string
  /** Budget controls exploration depth: low=3, mid=5, high=8 iterations. Default: "mid" */
  budget?: import("./schemas").ReflectBudget
  /** Filter by tags (propagated to all tier searches) */
  tags?: string[]
  /** Tag matching mode. Default: "any" */
  tagsMatch?: import("./schemas").TagsMatch
  /** Optional JSON schema for structured output extraction from the answer. */
  responseSchema?: Record<string, unknown>
}

// ── Results ────────────────────────────────────────────────────────────────

/** Result from retainBatch(): one RetainResult per input content item */
export type RetainBatchResult = import("./schemas").RetainResult[]

/** Result from recall() */
export interface RecallResult {
  memories: import("./schemas").ScoredMemory[]
  query: string
  entities?: Record<string, RecallEntityState>
  chunks?: Record<string, RecallChunk>
  trace?: RecallTrace
}

/** Result from reflect() */
export interface ReflectResult {
  answer: string
  memories: import("./schemas").ScoredMemory[]
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
  // Cognitive mode fields (present when mode="cognitive")
  probeActivation?: number
  baseLevelActivation?: number
  spreadingActivation?: number
  wmBoost?: number
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
  entityType: import("./schemas").EntityType
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
  factType: import("./schemas").FactType
  documentId: string | null
  chunkId: string | null
  tags: string[]
  sourceMemoryIds: string[]
}

export interface GraphEdge {
  sourceId: string
  targetId: string
  linkType: import("./schemas").LinkType
  weight: number
}

export interface ClearObservationsResult {
  deletedCount: number
}

export interface EntityState {
  entityId: string
  canonicalName: string
  observations: Array<Record<string, unknown>>
}

export interface UpdateEntityOptions {
  canonicalName?: string
  description?: string | null
  metadata?: Record<string, unknown> | null
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

/** Options for creating a mental model */
export interface CreateMentalModelOptions {
  /** Optional custom ID (parity with Python mental_model_id) */
  id?: string
  /** Optional alias for custom ID (Python-style naming) */
  mentalModelId?: string
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

/** Options for listing mental models */
export interface ListMentalModelsOptions {
  /** Filter mental models by tag overlap (any-match) */
  tags?: string[]
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
  freshness: import("./schemas").Freshness
}

/** Return shape from search_memories / raw facts tool (Tier 3) */
export interface RawFactSearchResult {
  id: string
  content: string
  factType: import("./schemas").FactType
  entities: string[]
  score: number
  occurredAt: number | null
}

// ── Reconsolidation Routing ─────────────────────────────────────────────

/** Route decision for ingest-time reconsolidation. */
export type ReconRoute = "reinforce" | "reconsolidate" | "new_trace"
/** Alias for ReconRoute; prefer ReconRoute in new code. */
export type RetainRoute = ReconRoute

/** Result of routing a single incoming fact against existing memories. */
export interface RouteDecision {
  route: ReconRoute
  /** The existing memory that was matched (null for new_trace with no candidate) */
  candidateMemoryId: string | null
  /** Cosine similarity score with the candidate */
  candidateScore: number | null
  /** Whether a fact conflict was detected */
  conflictDetected: boolean
  /** Entity|attribute keys that conflicted */
  conflictKeys: string[]
}

// ── Episodes ────────────────────────────────────────────────────────────

export type EpisodeBoundaryReason = "time_gap" | "scope_change" | "phrase_boundary" | "initial"

export interface EpisodeSummary {
  episodeId: string
  startAt: number
  endAt: number | null
  lastEventAt: number
  eventCount: number
  boundaryReason: EpisodeBoundaryReason | null
  profile: string | null
  project: string | null
  session: string | null
}

export interface ListEpisodesOptions {
  bankId: string
  profile?: string
  project?: string
  session?: string
  limit?: number
  cursor?: string
}

export interface ListEpisodesResult {
  items: EpisodeSummary[]
  total: number
  limit: number
  cursor: string | null
}

/** Default number of narrative steps when not specified. */
export const NARRATIVE_STEPS_DEFAULT = 12
/** Maximum allowed narrative steps (clamped in consumers). */
export const NARRATIVE_STEPS_MAX = 50

export interface NarrativeInput {
  bankId: string
  anchorMemoryId: string
  direction?: "before" | "after" | "both"
  /**
   * Number of episode-chain steps to traverse from the anchor.
   * Defaults to {@link NARRATIVE_STEPS_DEFAULT} (12).
   * Clamped to [1, {@link NARRATIVE_STEPS_MAX} (50)].
   */
  steps?: number
}

export interface NarrativeEvent {
  memoryId: string
  episodeId: string
  eventTime: number
  route: ReconRoute
  contentSnippet: string
}

export interface NarrativeResult {
  events: NarrativeEvent[]
  anchorMemoryId: string
}
