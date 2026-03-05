// Schema-derived types (source of truth: ../schemas.ts)
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
	RetainResult
} from '../schemas'

// Config, embedding, tracing, extensions
export type {
	TranscriptTurn,
	RetainContentInput,
	LinkDirection,
	MetaPathStep,
	MetaPath,
	EmbedFunction,
	EmbedBatchFunction,
	RerankFunction,
	HindsightTrace,
	TraceCallback,
	HindsightOperationName,
	HindsightOperationContext,
	HindsightOperationResultContext,
	HindsightExtensions,
	HindsightConfig
} from './config'

// Operation options and results
export type {
	RetainOptions,
	RetainBatchOptions,
	RetainBatchItem,
	RecallMode,
	RecallOptions,
	ReflectOptions,
	RetainBatchResult,
	RecallResult,
	MethodResult,
	ReflectResult,
	RecallEntityState,
	RecallChunk,
	RecallTraceMetric,
	RecallTraceMethodResult,
	RecallTraceCandidate,
	RecallTrace,
	ConsolidateOptions,
	ConsolidateResult,
	ConsolidationAction
} from './operations'

// Storage records, entities, tags, async operations
export type {
	DocumentRecord,
	ChunkRecord,
	GraphNode,
	GraphEdge,
	ClearObservationsResult,
	EntityState,
	UpdateEntityOptions,
	TagUsage,
	ListTagsOptions,
	ListTagsResult,
	AsyncOperationType,
	AsyncOperationStatus,
	AsyncOperationApiStatus,
	AsyncOperationSummary,
	ListOperationsOptions,
	ListOperationsResult,
	OperationStatusResult,
	SubmitAsyncOperationResult,
	SubmitAsyncRetainResult,
	CancelOperationResult
} from './storage'

// Mental models, directives, reflect search, routing, episodes, narrative, visual
export {
	NARRATIVE_STEPS_DEFAULT,
	NARRATIVE_STEPS_MAX
} from './features'
export type {
	MentalModel,
	CreateMentalModelOptions,
	UpdateMentalModelOptions,
	ListMentalModelsOptions,
	RefreshMentalModelResult,
	Directive,
	CreateDirectiveOptions,
	UpdateDirectiveOptions,
	MentalModelSearchResult,
	ObservationSearchResult,
	RawFactSearchResult,
	ReconRoute,
	RetainRoute,
	RouteDecision,
	EpisodeBoundaryReason,
	EpisodeSummary,
	ListEpisodesOptions,
	ListEpisodesResult,
	NarrativeInput,
	NarrativeEvent,
	NarrativeResult,
	VisualRetainInput,
	VisualRetainResult,
	ScoredVisualMemory,
	VisualStats,
	VisualFindHit
} from './features'
