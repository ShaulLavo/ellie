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
	factType: import('../schemas').FactType
	documentId: string | null
	chunkId: string | null
	tags: string[]
	sourceMemoryIds: string[]
}

export interface GraphEdge {
	sourceId: string
	targetId: string
	linkType: import('../schemas').LinkType
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

export type AsyncOperationType =
	| 'retain'
	| 'consolidation'
	| 'refresh_mental_model'

export type AsyncOperationStatus =
	| 'pending'
	| 'processing'
	| 'completed'
	| 'failed'

export type AsyncOperationApiStatus =
	| 'pending'
	| 'completed'
	| 'failed'
	| 'not_found'

export interface AsyncOperationSummary {
	id: string
	taskType: AsyncOperationType
	itemsCount: number
	documentId: string | null
	createdAt: number
	status: Exclude<AsyncOperationApiStatus, 'not_found'>
	errorMessage: string | null
}

export interface ListOperationsOptions {
	status?: Exclude<AsyncOperationApiStatus, 'not_found'>
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
