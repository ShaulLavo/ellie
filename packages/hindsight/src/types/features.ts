import type { ReflectResult } from './shared'
import type { DispositionTraits } from '../schemas'

/** Bank profile passed to reflect for prompt injection */
export interface BankProfile {
	name: string
	mission: string
	disposition: DispositionTraits
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
	freshness: import('../schemas').Freshness
}

/** Return shape from search_memories / raw facts tool (Tier 3) */
export interface RawFactSearchResult {
	id: string
	content: string
	factType: import('../schemas').FactType
	entities: string[]
	score: number
	occurredAt: number | null
}

/** Route decision for ingest-time reconsolidation. */
export type ReconRoute =
	| 'reinforce'
	| 'reconsolidate'
	| 'new_trace'
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

export type EpisodeBoundaryReason =
	| 'time_gap'
	| 'scope_change'
	| 'phrase_boundary'
	| 'initial'

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
	direction?: 'before' | 'after' | 'both'
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

/** Input for retaining a visual description. */
export interface VisualRetainInput {
	/** Bank to store in */
	bankId: string
	/** Caller-owned reference ID */
	sourceId?: string
	/** Caption / scene summary text (required) */
	description: string
	/** Epoch ms timestamp */
	ts?: number
	/** Scope tags */
	scope?: {
		profile?: string
		project?: string
		session?: string
	}
}

/** Result from retaining a visual description. */
export interface VisualRetainResult {
	id: string
	bankId: string
	sourceId: string | null
	description: string
	createdAt: number
}

/** A scored visual memory returned from recall fusion. */
export type { ScoredVisualMemory } from './shared'

/** Stats for visual memories in a bank. */
export interface VisualStats {
	bankId: string
	totalVisualMemories: number
	totalAccessEvents: number
}

/** A visual memory search hit. */
export interface VisualFindHit {
	id: string
	sourceId: string | null
	description: string
	distance: number
	createdAt: number
}
