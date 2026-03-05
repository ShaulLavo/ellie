import type { AnyTextAdapter } from '@tanstack/ai'

/** Canonical transcript turn format for extraction parity with Python Hindsight. */
export interface TranscriptTurn {
	role: string
	content: string
}

/** Supported retain content input. */
export type RetainContentInput = string | TranscriptTurn[]

// ── Meta-Path Graph Retrieval ─────────────────────────────────────────────

/** Direction constraint for a meta-path step */
export type LinkDirection = 'forward' | 'backward' | 'both'

/** A single step in a meta-path: which link type to traverse and in which direction */
export interface MetaPathStep {
	/** Link type to traverse in this step */
	linkType: import('../schemas').LinkType
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

// ── Embedding & Ranking ──────────────────────────────────────────────────

/** User-provided embedding function: text → float array */
export type EmbedFunction = (
	text: string
) => Promise<number[]>
/** Optional user-provided embedding batch function: texts → float arrays */
export type EmbedBatchFunction = (
	texts: string[]
) => Promise<number[][]>

/** User-provided reranking function: (query, documents) → relevance scores (higher = more relevant) */
export type RerankFunction = (
	query: string,
	documents: string[]
) => Promise<number[]>

// ── Tracing ───────────────────────────────────────────────────────────────

/** Trace emitted after each core operation completes */
export interface HindsightTrace {
	operation:
		| 'retain'
		| 'recall'
		| 'reflect'
		| 'consolidate'
		| 'list_episodes'
		| 'narrative'
	bankId: string
	startedAt: number
	duration: number
	metadata: Record<string, unknown>
}

/** Callback for receiving operation traces */
export type TraceCallback = (trace: HindsightTrace) => void

export type HindsightOperationName =
	| 'retain'
	| 'retain_batch'
	| 'recall'
	| 'reflect'
	| 'consolidate'
	| 'list_episodes'
	| 'narrative'
	| 'submit_async_retain'
	| 'submit_async_consolidation'
	| 'submit_async_refresh_mental_model'

export interface HindsightOperationContext {
	operation: HindsightOperationName
	bankId: string
	tenantId: string
	input: Record<string, unknown>
}

export interface HindsightOperationResultContext extends HindsightOperationContext {
	success: boolean
	result?: unknown
	error?: string
}

export interface HindsightExtensions {
	/** Optional tenant resolver. Defaults to the bankId when not provided. */
	resolveTenantId?: (bankId: string) => string | undefined
	/** Optional auth hook called before operations run. */
	authorize?: (
		context: HindsightOperationContext
	) => void | Promise<void>
	/** Optional validator hook called before operations run. */
	validate?: (
		context: HindsightOperationContext
	) => void | Promise<void>
	/** Optional completion hook called after operation success/failure. */
	onComplete?: (
		context: HindsightOperationResultContext
	) => void | Promise<void>
}

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
	defaults?: import('../schemas').BankConfig
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
