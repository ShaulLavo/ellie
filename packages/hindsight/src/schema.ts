import {
	sqliteTable,
	text,
	integer,
	real,
	index,
	uniqueIndex,
	primaryKey,
	check
} from 'drizzle-orm/sqlite-core'
import { desc, sql } from 'drizzle-orm'

// ── Banks ──────────────────────────────────────────────────────────────────

export const banks = sqliteTable('hs_banks', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(),
	description: text('description'),
	config: text('config'), // JSON BankConfig
	disposition: text('disposition'), // JSON DispositionTraits {skepticism, literalism, empathy} 1-5
	mission: text('mission').notNull().default(''), // First-person mission statement
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
})

// ── Documents ──────────────────────────────────────────────────────────────

export const documents = sqliteTable(
	'hs_documents',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		originalText: text('original_text'),
		contentHash: text('content_hash'),
		metadata: text('metadata'), // JSON blob
		retainParams: text('retain_params'), // JSON blob
		tags: text('tags'), // JSON array of strings
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	table => [
		index('idx_hs_doc_bank').on(table.bankId),
		index('idx_hs_doc_hash').on(table.contentHash)
	]
)

// ── Chunks ─────────────────────────────────────────────────────────────────

export const chunks = sqliteTable(
	'hs_chunks',
	{
		id: text('id').primaryKey(),
		documentId: text('document_id')
			.notNull()
			.references(() => documents.id, {
				onDelete: 'cascade'
			}),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		content: text('content').notNull(),
		chunkIndex: integer('chunk_index').notNull(),
		createdAt: integer('created_at').notNull()
	},
	table => [
		index('idx_hs_chunk_bank').on(table.bankId),
		index('idx_hs_chunk_doc').on(table.documentId)
	]
)

// ── Memory Units ───────────────────────────────────────────────────────────

export const memoryUnits = sqliteTable(
	'hs_memory_units',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		content: text('content').notNull(),
		factType: text('fact_type').notNull(), // world | experience | opinion | observation
		confidence: real('confidence').notNull().default(1.0),
		documentId: text('document_id'),
		chunkId: text('chunk_id'),
		eventDate: integer('event_date'), // epoch ms anchor (occurred_start if present, else mentioned_at)
		occurredStart: integer('occurred_start'), // epoch ms when the event started
		occurredEnd: integer('occurred_end'), // epoch ms when the event ended
		mentionedAt: integer('mentioned_at'), // epoch ms — when the content was mentioned (vs when stored)
		metadata: text('metadata'), // JSON blob
		tags: text('tags'), // JSON array of strings
		sourceText: text('source_text'), // original text this was extracted from
		consolidatedAt: integer('consolidated_at'), // epoch ms — when this memory was processed by consolidation
		proofCount: integer('proof_count').notNull().default(0), // observations: number of supporting facts
		sourceMemoryIds: text('source_memory_ids'), // observations: JSON array of ULID refs
		history: text('history'), // observations: JSON array of change entries
		accessCount: integer('access_count')
			.notNull()
			.default(0), // cognitive: times recalled
		lastAccessed: integer('last_accessed'), // cognitive: epoch ms of last recall (nullable for legacy rows)
		encodingStrength: real('encoding_strength')
			.notNull()
			.default(1.0), // cognitive: strengthened by recall
		gist: text('gist'), // Phase 3: compact summary (max 280 chars) for context packing
		scopeProfile: text('scope_profile'), // Phase 3: profile scope tag
		scopeProject: text('scope_project'), // Phase 3: project scope tag
		scopeSession: text('scope_session'), // Phase 3: session scope tag
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	table => [
		index('idx_hs_mu_bank').on(table.bankId),
		index('idx_hs_mu_fact_type').on(
			table.bankId,
			table.factType
		),
		index('idx_hs_mu_document').on(
			table.bankId,
			table.documentId
		),
		index('idx_hs_mu_chunk').on(table.chunkId),
		index('idx_hs_mu_event_date').on(
			table.bankId,
			table.eventDate
		),
		index('idx_hs_mu_occurred_range').on(
			table.bankId,
			table.occurredStart,
			table.occurredEnd
		),
		index('idx_hs_mu_mentioned_at').on(
			table.bankId,
			table.mentionedAt
		),
		index('idx_hs_mu_consolidated').on(
			table.bankId,
			table.consolidatedAt
		),
		index('idx_hs_mu_last_accessed').on(
			table.bankId,
			table.lastAccessed
		),
		index('idx_hs_mu_access_count').on(
			table.bankId,
			table.accessCount
		),
		index('idx_hs_mu_scope').on(
			table.bankId,
			table.scopeProfile,
			table.scopeProject
		),
		check(
			'hs_mu_encoding_strength_range',
			sql`encoding_strength >= 0 AND encoding_strength <= 3.0`
		)
	]
)

// ── Entities ───────────────────────────────────────────────────────────────

export const entities = sqliteTable(
	'hs_entities',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		entityType: text('entity_type').notNull(), // person | organization | place | concept | other
		description: text('description'),
		metadata: text('metadata'), // JSON blob
		mentionCount: integer('mention_count')
			.notNull()
			.default(0),
		firstSeen: integer('first_seen').notNull(),
		lastUpdated: integer('last_updated').notNull()
	},
	table => [
		index('idx_hs_ent_bank_name').on(
			table.bankId,
			table.name
		),
		index('idx_hs_ent_type').on(
			table.bankId,
			table.entityType
		)
	]
)

// ── Memory ↔ Entity junction ───────────────────────────────────────────────

export const memoryEntities = sqliteTable(
	'hs_memory_entities',
	{
		memoryId: text('memory_id')
			.notNull()
			.references(() => memoryUnits.id, {
				onDelete: 'cascade'
			}),
		entityId: text('entity_id')
			.notNull()
			.references(() => entities.id, {
				onDelete: 'cascade'
			})
	},
	table => [
		primaryKey({
			columns: [table.memoryId, table.entityId]
		}),
		index('idx_hs_me_entity').on(table.entityId)
	]
)

// ── Memory Links ───────────────────────────────────────────────────────────

export const memoryLinks = sqliteTable(
	'hs_memory_links',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		sourceId: text('source_id')
			.notNull()
			.references(() => memoryUnits.id, {
				onDelete: 'cascade'
			}),
		targetId: text('target_id')
			.notNull()
			.references(() => memoryUnits.id, {
				onDelete: 'cascade'
			}),
		linkType: text('link_type').notNull(), // temporal | semantic | entity | causes | caused_by | enables | prevents
		weight: real('weight').notNull().default(1.0),
		metadata: text('metadata'), // JSON blob
		createdAt: integer('created_at').notNull()
	},
	table => [
		index('idx_hs_link_source').on(table.sourceId),
		index('idx_hs_link_target').on(table.targetId),
		index('idx_hs_link_bank_type').on(
			table.bankId,
			table.linkType
		),
		uniqueIndex('idx_hs_link_edge').on(
			table.sourceId,
			table.targetId,
			table.linkType
		)
	]
)

// ── Entity Co-occurrences ──────────────────────────────────────────────────

export const entityCooccurrences = sqliteTable(
	'hs_entity_cooccurrences',
	{
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		entityA: text('entity_a')
			.notNull()
			.references(() => entities.id, {
				onDelete: 'cascade'
			}),
		entityB: text('entity_b')
			.notNull()
			.references(() => entities.id, {
				onDelete: 'cascade'
			}),
		count: integer('count').notNull().default(1)
	},
	table => [
		primaryKey({
			columns: [table.bankId, table.entityA, table.entityB]
		}),
		index('idx_hs_cooc_bank').on(table.bankId),
		check(
			'hs_cooc_canonical_order',
			sql`entity_a <= entity_b`
		)
	]
)

// ── Mental Models ─────────────────────────────────────────────────────────

export const mentalModels = sqliteTable(
	'hs_mental_models',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		sourceQuery: text('source_query').notNull(),
		content: text('content'), // synthesized answer
		sourceMemoryIds: text('source_memory_ids'), // JSON array of ULID refs
		tags: text('tags'), // JSON array for scoping
		autoRefresh: integer('auto_refresh')
			.notNull()
			.default(0), // 0=false, 1=true
		lastRefreshedAt: integer('last_refreshed_at'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	table => [
		index('idx_hs_mm_bank').on(table.bankId),
		uniqueIndex('idx_hs_mm_bank_name').on(
			table.bankId,
			table.name
		)
	]
)

// ── Directives ──────────────────────────────────────────────────────────

export const directives = sqliteTable(
	'hs_directives',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		content: text('content').notNull(),
		priority: integer('priority').notNull().default(0),
		isActive: integer('is_active').notNull().default(1), // 0=false, 1=true
		tags: text('tags'), // JSON string[]
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	table => [
		index('idx_hs_dir_bank').on(table.bankId),
		index('idx_hs_dir_bank_active').on(
			table.bankId,
			table.isActive
		)
	]
)

// ── Async Operations ──────────────────────────────────────────────────────

export const asyncOperations = sqliteTable(
	'hs_async_operations',
	{
		operationId: text('operation_id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		operationType: text('operation_type').notNull(), // retain | consolidation | refresh_mental_model
		status: text('status').notNull().default('pending'), // pending | processing | completed | failed
		resultMetadata: text('result_metadata'), // JSON blob
		errorMessage: text('error_message'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		completedAt: integer('completed_at')
	},
	table => [
		index('idx_hs_ops_bank').on(table.bankId),
		index('idx_hs_ops_status').on(table.status),
		index('idx_hs_ops_bank_status').on(
			table.bankId,
			table.status
		)
	]
)

// ── Memory Versions ─────────────────────────────────────────────────────

export const memoryVersions = sqliteTable(
	'hs_memory_versions',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		memoryId: text('memory_id')
			.notNull()
			.references(() => memoryUnits.id, {
				onDelete: 'cascade'
			}),
		versionNo: integer('version_no').notNull(),
		content: text('content').notNull(),
		entitiesJson: text('entities_json'), // JSON: [{name, entityType}]
		attributesJson: text('attributes_json'), // JSON: {factType, confidence, tags, metadata}
		reason: text('reason').notNull(),
		createdAt: integer('created_at').notNull()
	},
	table => [
		index('idx_hs_mv_memory').on(table.memoryId),
		index('idx_hs_mv_bank').on(table.bankId),
		uniqueIndex('idx_hs_mv_memory_version').on(
			table.memoryId,
			table.versionNo
		)
	]
)

// ── Reconsolidation Decisions ───────────────────────────────────────────

/**
 * Audit log for reconsolidation routing decisions.
 *
 * FK constraints are intentionally omitted for candidate_memory_id and
 * applied_memory_id. These columns reference hs_memory_units, but decision
 * rows must survive memory deletion to preserve the audit trail.
 */
export const reconsolidationDecisions = sqliteTable(
	'hs_reconsolidation_decisions',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		candidateMemoryId: text('candidate_memory_id'), // null for new_trace
		appliedMemoryId: text('applied_memory_id').notNull(),
		route: text('route').notNull(), // reinforce | reconsolidate | new_trace
		candidateScore: real('candidate_score'),
		conflictDetected: integer('conflict_detected')
			.notNull()
			.default(0), // 0=false, 1=true
		conflictKeysJson: text('conflict_keys_json'), // JSON array of conflicting keys
		policyVersion: text('policy_version')
			.notNull()
			.default('v1'),
		createdAt: integer('created_at').notNull()
	},
	table => [
		index('idx_hs_rd_bank_created').on(
			table.bankId,
			desc(table.createdAt)
		),
		index('idx_hs_rd_applied').on(table.appliedMemoryId)
	]
)

// ── Episodes ────────────────────────────────────────────────────────────

export const episodes = sqliteTable(
	'hs_episodes',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		profile: text('profile'),
		project: text('project'),
		session: text('session'),
		startAt: integer('start_at').notNull(),
		endAt: integer('end_at'),
		lastEventAt: integer('last_event_at').notNull(),
		eventCount: integer('event_count').notNull().default(0),
		boundaryReason: text('boundary_reason') // time_gap | scope_change | phrase_boundary | initial
	},
	table => [
		index('idx_hs_ep_bank_last_event').on(
			table.bankId,
			desc(table.lastEventAt)
		),
		index('idx_hs_ep_scope').on(
			table.bankId,
			table.profile,
			table.project,
			table.session
		)
	]
)

// ── Episode Events ──────────────────────────────────────────────────────

export const episodeEvents = sqliteTable(
	'hs_episode_events',
	{
		id: text('id').primaryKey(),
		episodeId: text('episode_id')
			.notNull()
			.references(() => episodes.id, {
				onDelete: 'cascade'
			}),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		memoryId: text('memory_id')
			.notNull()
			.references(() => memoryUnits.id, {
				onDelete: 'cascade'
			}),
		eventTime: integer('event_time').notNull(),
		route: text('route').notNull(), // reinforce | reconsolidate | new_trace
		profile: text('profile'),
		project: text('project'),
		session: text('session')
	},
	table => [
		index('idx_hs_ee_episode_time').on(
			table.episodeId,
			table.eventTime
		),
		index('idx_hs_ee_bank_memory').on(
			table.bankId,
			table.memoryId,
			desc(table.eventTime)
		)
	]
)

// ── Episode Temporal Links ──────────────────────────────────────────────

export const episodeTemporalLinks = sqliteTable(
	'hs_episode_temporal_links',
	{
		id: text('id').primaryKey(),
		fromEpisodeId: text('from_episode_id')
			.notNull()
			.references(() => episodes.id, {
				onDelete: 'cascade'
			}),
		toEpisodeId: text('to_episode_id')
			.notNull()
			.references(() => episodes.id, {
				onDelete: 'cascade'
			}),
		reason: text('reason').notNull(),
		gapMs: integer('gap_ms').notNull(),
		createdAt: integer('created_at').notNull()
	},
	table => [
		index('idx_hs_etl_from').on(table.fromEpisodeId),
		index('idx_hs_etl_to').on(table.toEpisodeId),
		uniqueIndex('idx_hs_etl_edge').on(
			table.fromEpisodeId,
			table.toEpisodeId
		)
	]
)

// ── Location Paths ────────────────────────────────────────────────────────

export const locationPaths = sqliteTable(
	'hs_location_paths',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		rawPath: text('raw_path').notNull(),
		normalizedPath: text('normalized_path').notNull(),
		profile: text('profile').notNull().default('default'),
		project: text('project').notNull().default('default'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	table => [
		uniqueIndex('idx_hs_lp_unique').on(
			table.bankId,
			table.normalizedPath,
			table.profile,
			table.project
		),
		index('idx_hs_lp_bank_norm').on(
			table.bankId,
			table.normalizedPath
		)
	]
)

// ── Location Access Contexts ──────────────────────────────────────────────

export const locationAccessContexts = sqliteTable(
	'hs_location_access_contexts',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		pathId: text('path_id')
			.notNull()
			.references(() => locationPaths.id, {
				onDelete: 'cascade'
			}),
		memoryId: text('memory_id')
			.notNull()
			.references(() => memoryUnits.id, {
				onDelete: 'cascade'
			}),
		session: text('session'),
		activityType: text('activity_type')
			.notNull()
			.default('access'), // access | retain | recall
		accessedAt: integer('accessed_at').notNull()
	},
	table => [
		index('idx_hs_lac_path_time').on(
			table.bankId,
			table.pathId,
			desc(table.accessedAt)
		),
		index('idx_hs_lac_memory_time').on(
			table.bankId,
			table.memoryId,
			desc(table.accessedAt)
		)
	]
)

// ── Location Associations ─────────────────────────────────────────────────

export const locationAssociations = sqliteTable(
	'hs_location_associations',
	{
		id: text('id').primaryKey(),
		bankId: text('bank_id')
			.notNull()
			.references(() => banks.id, { onDelete: 'cascade' }),
		sourcePathId: text('source_path_id')
			.notNull()
			.references(() => locationPaths.id, {
				onDelete: 'cascade'
			}),
		relatedPathId: text('related_path_id')
			.notNull()
			.references(() => locationPaths.id, {
				onDelete: 'cascade'
			}),
		coAccessCount: integer('co_access_count')
			.notNull()
			.default(1),
		strength: real('strength').notNull().default(0.0),
		updatedAt: integer('updated_at').notNull()
	},
	table => [
		uniqueIndex('idx_hs_la_edge').on(
			table.bankId,
			table.sourcePathId,
			table.relatedPathId
		),
		index('idx_hs_la_source').on(
			table.bankId,
			table.sourcePathId
		)
	]
)

// ── Type exports ───────────────────────────────────────────────────────────

export type BankRow = typeof banks.$inferSelect
export type NewBankRow = typeof banks.$inferInsert
export type DocumentRow = typeof documents.$inferSelect
export type NewDocumentRow = typeof documents.$inferInsert
export type ChunkRow = typeof chunks.$inferSelect
export type NewChunkRow = typeof chunks.$inferInsert
export type MemoryUnitRow = typeof memoryUnits.$inferSelect
export type NewMemoryUnitRow =
	typeof memoryUnits.$inferInsert
export type EntityRow = typeof entities.$inferSelect
export type NewEntityRow = typeof entities.$inferInsert
export type MemoryEntityRow =
	typeof memoryEntities.$inferSelect
export type MemoryLinkRow = typeof memoryLinks.$inferSelect
export type NewMemoryLinkRow =
	typeof memoryLinks.$inferInsert
export type EntityCooccurrenceRow =
	typeof entityCooccurrences.$inferSelect
export type MentalModelRow =
	typeof mentalModels.$inferSelect
export type NewMentalModelRow =
	typeof mentalModels.$inferInsert
export type DirectiveRow = typeof directives.$inferSelect
export type NewDirectiveRow = typeof directives.$inferInsert
export type AsyncOperationRow =
	typeof asyncOperations.$inferSelect
export type NewAsyncOperationRow =
	typeof asyncOperations.$inferInsert
export type MemoryVersionRow =
	typeof memoryVersions.$inferSelect
export type NewMemoryVersionRow =
	typeof memoryVersions.$inferInsert
export type ReconsolidationDecisionRow =
	typeof reconsolidationDecisions.$inferSelect
export type NewReconsolidationDecisionRow =
	typeof reconsolidationDecisions.$inferInsert
export type EpisodeRow = typeof episodes.$inferSelect
export type NewEpisodeRow = typeof episodes.$inferInsert
export type EpisodeEventRow =
	typeof episodeEvents.$inferSelect
export type NewEpisodeEventRow =
	typeof episodeEvents.$inferInsert
export type EpisodeTemporalLinkRow =
	typeof episodeTemporalLinks.$inferSelect
export type NewEpisodeTemporalLinkRow =
	typeof episodeTemporalLinks.$inferInsert
export type LocationPathRow =
	typeof locationPaths.$inferSelect
export type NewLocationPathRow =
	typeof locationPaths.$inferInsert
export type LocationAccessContextRow =
	typeof locationAccessContexts.$inferSelect
export type NewLocationAccessContextRow =
	typeof locationAccessContexts.$inferInsert
export type LocationAssociationRow =
	typeof locationAssociations.$inferSelect
export type NewLocationAssociationRow =
	typeof locationAssociations.$inferInsert
