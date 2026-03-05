import type { ScoredVisualMemory } from './features'
import type { RetainContentInput } from './config'

// ── Operation options ──────────────────────────────────────────────────────

/** Options for retain() */
export interface RetainOptions {
	/** Provide pre-extracted facts (skips LLM extraction) */
	facts?: Array<{
		content: string
		factType?: import('../schemas').FactType
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
	mode?: 'concise' | 'verbose' | 'custom'
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
export type RetainBatchOptions = Omit<
	RetainOptions,
	'facts'
>

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
export type RecallMode = 'hybrid' | 'cognitive'

/** Options for recall() */
export interface RecallOptions {
	/** Maximum results to return. Default: 10 */
	limit?: number
	/** Optional token budget for returned memory content (raw truncation). @see tokenBudget for gist-first packing. */
	maxTokens?: number
	/** Minimum confidence threshold. Default: 0 */
	minConfidence?: number
	/** Filter by fact types */
	factTypes?: import('../schemas').FactType[]
	/** Filter by entity names */
	entities?: string[]
	/** Time range filter (epoch ms) */
	timeRange?: { from?: number; to?: number }
	/** Which retrieval methods to use. Default: all */
	methods?: Array<
		'semantic' | 'fulltext' | 'graph' | 'temporal'
	>
	/** Filter by tags */
	tags?: string[]
	/** Tag matching mode. Default: "any" */
	tagsMatch?: import('../schemas').TagsMatch
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
	/**
	 * Phase 3: Token budget for gist-first context packing. When set, memories are packed
	 * using gist/full strategy (top-2 full, then 70% gist / 30% full backfill).
	 * Takes precedence over maxTokens for packing decisions.
	 * @see maxTokens — applies raw content truncation independently.
	 */
	tokenBudget?: number
	/** Phase 3: Scope filter for preventing cross-project memory bleed. */
	scope?: {
		profile?: string
		project?: string
		session?: string
	}
	/** Phase 3: Scope matching mode. "strict" = same profile+project (default). "broad" = no scope filter. */
	scopeMode?: 'strict' | 'broad'
	/** Phase 4: Include visual semantic memories in recall results. Default: false */
	includeVisual?: boolean
	/** Phase 4: Maximum share of final results that can be visual entries. Default: 0.2, hard cap 0.2 */
	visualMaxShare?: number
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
	budget?: import('../schemas').ReflectBudget
	/** Filter by tags (propagated to all tier searches) */
	tags?: string[]
	/** Tag matching mode. Default: "any" */
	tagsMatch?: import('../schemas').TagsMatch
	/** Optional JSON schema for structured output extraction from the answer. */
	responseSchema?: Record<string, unknown>
}

// ── Results ────────────────────────────────────────────────────────────────

/** Result from retainBatch(): one RetainResult per input content item */
export type RetainBatchResult =
	import('../schemas').RetainResult[]

/** Result from recall() */
export interface RecallResult {
	memories: import('../schemas').ScoredMemory[]
	query: string
	entities?: Record<string, RecallEntityState>
	chunks?: Record<string, RecallChunk>
	trace?: RecallTrace
	/** Phase 4: Visual memory results (only when includeVisual=true) */
	visualMemories?: ScoredVisualMemory[]
	/** Per-method search results (populated when available, for audit) */
	methodResults?: Record<string, MethodResult>
}

export interface MethodResult {
	hits: Array<{ id: string; score: number }>
	error?: string
}

/** Result from reflect() */
export interface ReflectResult {
	answer: string
	memories: import('../schemas').ScoredMemory[]
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

/** Aggregated entity state payload returned by recall(includeEntities=true). */
export interface RecallEntityState {
	id: string
	name: string
	entityType: import('../schemas').EntityType
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

// ── Recall Trace ──────────────────────────────────────────────────────────

export interface RecallTraceMetric {
	phaseName: string
	durationMs: number
	details?: Record<string, unknown>
}

export interface RecallTraceMethodResult {
	methodName: 'semantic' | 'fulltext' | 'graph' | 'temporal'
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
	sources: Array<
		'semantic' | 'fulltext' | 'graph' | 'temporal'
	>
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

// ── Consolidation ────────────────────────────────────────────────────────

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
	| { action: 'create'; text: string; reason: string }
	| {
			action: 'update'
			observationId: string
			text: string
			reason: string
	  }
	| {
			action: 'merge'
			observationIds: string[]
			text: string
			reason: string
	  }
	| { action: 'skip'; reason?: string }
