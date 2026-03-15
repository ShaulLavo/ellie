import {
	sqliteTable,
	text,
	integer,
	index,
	uniqueIndex
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// -- Threads ------------------------------------------------------------------

export const threads = sqliteTable('threads', {
	id: text('id').primaryKey().notNull(),
	agentId: text('agent_id').notNull(),
	agentType: text('agent_type').notNull(),
	workspaceId: text('workspace_id').notNull(),
	title: text('title'),
	state: text('state').notNull().default('active'),
	dayKey: text('day_key'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
})

export type ThreadRow = typeof threads.$inferSelect
export type NewThreadRow = typeof threads.$inferInsert

// -- Branches -----------------------------------------------------------------

export const branches = sqliteTable('branches', {
	id: text('id').primaryKey().notNull(),
	threadId: text('thread_id')
		.notNull()
		.references(() => threads.id, { onDelete: 'cascade' }),
	parentBranchId: text('parent_branch_id'),
	forkedFromEventId: integer('forked_from_event_id'),
	forkedFromSeq: integer('forked_from_seq'),
	currentSeq: integer('current_seq').notNull().default(0),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
})

export type BranchRow = typeof branches.$inferSelect
export type NewBranchRow = typeof branches.$inferInsert

// -- Events -------------------------------------------------------------------

export const events = sqliteTable(
	'events',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		branchId: text('branch_id')
			.notNull()
			.references(() => branches.id, {
				onDelete: 'cascade'
			}),
		seq: integer('seq').notNull(),
		runId: text('run_id'),
		type: text('type').notNull(),
		payload: text('payload').notNull(),
		dedupeKey: text('dedupe_key'),
		createdAt: integer('created_at').notNull()
	},
	table => [
		uniqueIndex('idx_events_branch_seq').on(
			table.branchId,
			table.seq
		),
		index('idx_events_branch_type').on(
			table.branchId,
			table.type
		),
		index('idx_events_branch_run_seq').on(
			table.branchId,
			table.runId,
			table.seq
		),
		uniqueIndex('idx_events_branch_dedupe')
			.on(table.branchId, table.dedupeKey)
			.where(sql`dedupe_key IS NOT NULL`)
	]
)

export type EventRow = typeof events.$inferSelect
export type NewEventRow = typeof events.$inferInsert

// -- Thread Channels ----------------------------------------------------------

export const threadChannels = sqliteTable(
	'thread_channels',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		threadId: text('thread_id')
			.notNull()
			.references(() => threads.id, {
				onDelete: 'cascade'
			}),
		channelId: text('channel_id').notNull(),
		accountId: text('account_id').notNull(),
		conversationKey: text('conversation_key').notNull(),
		attachedAt: integer('attached_at').notNull(),
		detachedAt: integer('detached_at')
	},
	table => [
		index('idx_thread_channels_active').on(
			table.channelId,
			table.accountId,
			table.conversationKey
		)
	]
)

export type ThreadChannelRow =
	typeof threadChannels.$inferSelect
export type NewThreadChannelRow =
	typeof threadChannels.$inferInsert

// -- Agent Bootstrap State ---------------------------------------------------

export const agentBootstrapState = sqliteTable(
	'agent_bootstrap_state',
	{
		agentId: text('agent_id').primaryKey().notNull(),
		status: text('status').notNull().default('pending'),
		workspaceSeededAt: integer('workspace_seeded_at'),
		bootstrapInjectedAt: integer('bootstrap_injected_at'),
		bootstrapInjectedBranchId: text(
			'bootstrap_injected_branch_id'
		),
		onboardingCompletedAt: integer(
			'onboarding_completed_at'
		),
		lastError: text('last_error'),
		updatedAt: integer('updated_at').notNull()
	}
)

export type AgentBootstrapStateRow =
	typeof agentBootstrapState.$inferSelect
export type NewAgentBootstrapStateRow =
	typeof agentBootstrapState.$inferInsert

// -- Speech Artifacts ---------------------------------------------------------

export const speechArtifacts = sqliteTable(
	'speech_artifacts',
	{
		id: text('id').primaryKey().notNull(),
		status: text('status').notNull().default('draft'),
		blobPath: text('blob_path').notNull(),
		source: text('source').notNull(),
		flow: text('flow').notNull(),
		mime: text('mime').notNull(),
		size: integer('size').notNull(),
		normalizedBy: text('normalized_by').notNull(),
		transcriptText: text('transcript_text').notNull(),
		durationMs: integer('duration_ms').notNull(),
		speechDetected: integer('speech_detected', {
			mode: 'boolean'
		}).notNull(),
		createdAt: integer('created_at').notNull(),
		expiresAt: integer('expires_at').notNull(),
		claimedAt: integer('claimed_at'),
		claimedByBranchId: text('claimed_by_branch_id'),
		claimedByEventId: integer('claimed_by_event_id')
	},
	table => [
		index('idx_speech_status').on(table.status),
		index('idx_speech_expires').on(table.expiresAt)
	]
)

export type SpeechArtifactRow =
	typeof speechArtifacts.$inferSelect
export type NewSpeechArtifactRow =
	typeof speechArtifacts.$inferInsert

// -- Key-Value store ----------------------------------------------------------

export const kv = sqliteTable('kv', {
	key: text('key').primaryKey().notNull(),
	value: text('value').notNull()
})
