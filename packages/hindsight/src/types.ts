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
export type LinkType = "temporal" | "semantic" | "entity" | "causal"

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
  validFrom: number | null
  validTo: number | null
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

/** A memory bank (agent profile) */
export interface Bank {
  id: string
  name: string
  description: string | null
  config: BankConfig
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

/** Configuration for creating a Hindsight instance */
export interface HindsightConfig {
  /** Path to SQLite database file */
  dbPath: string
  /** TanStack AI text adapter for LLM calls. Default: anthropicText("claude-haiku-4-5") */
  adapter?: AnyTextAdapter
  /** Embedding function: text → float array (user-provided) */
  embed: EmbedFunction
  /** Embedding dimensions (must match embed output). Default: 1536 */
  embeddingDimensions?: number
  /** Enable automatic consolidation after retain. Default: true */
  enableConsolidation?: boolean
  /** Default bank config applied to all banks unless overridden per-bank */
  defaults?: BankConfig
  /** Called after each operation completes with timing + metadata */
  onTrace?: TraceCallback
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
  /** Extraction mode. Default: "concise" */
  mode?: "concise" | "verbose" | "custom"
  /** Custom extraction guidelines (only used when mode is "custom") */
  customGuidelines?: string
  /** Deduplication similarity threshold (0-1). Set to 0 to disable. Default: 0.92 */
  dedupThreshold?: number
  /** Trigger consolidation after retain. Default: true */
  consolidate?: boolean
}

/** Options for recall() */
export interface RecallOptions {
  /** Maximum results to return. Default: 10 */
  limit?: number
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
}

// ── Results ────────────────────────────────────────────────────────────────

/** Result from retain() */
export interface RetainResult {
  memories: MemoryUnit[]
  entities: Entity[]
  links: Array<{ sourceId: string; targetId: string; linkType: LinkType }>
}

/** Result from recall() */
export interface RecallResult {
  memories: ScoredMemory[]
  query: string
}

/** Result from reflect() */
export interface ReflectResult {
  answer: string
  memories: ScoredMemory[]
  observations: string[]
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
  /** Number of mental models refreshed */
  mentalModelsRefreshed: number
}

/** A single LLM-decided consolidation action */
export type ConsolidationAction =
  | { action: "create"; text: string; reason: string }
  | { action: "update"; observationId: string; text: string; reason: string }

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
  tags?: string[]
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
  factType: string
  entities: string[]
  score: number
  occurredAt: number | null
}
