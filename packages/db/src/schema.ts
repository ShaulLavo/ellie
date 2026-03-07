import {
	sqliteTable,
	text,
	integer,
	index,
	uniqueIndex
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// -- Sessions -----------------------------------------------------------------

export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey().notNull(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	currentSeq: integer('current_seq').notNull().default(0)
})

export type SessionRow = typeof sessions.$inferSelect
export type NewSessionRow = typeof sessions.$inferInsert

// -- Events -------------------------------------------------------------------

export const events = sqliteTable(
	'events',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		sessionId: text('session_id')
			.notNull()
			.references(() => sessions.id, {
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
		uniqueIndex('idx_events_session_seq').on(
			table.sessionId,
			table.seq
		),
		index('idx_events_session_type').on(
			table.sessionId,
			table.type
		),
		index('idx_events_session_run_seq').on(
			table.sessionId,
			table.runId,
			table.seq
		),
		uniqueIndex('idx_events_session_dedupe')
			.on(table.sessionId, table.dedupeKey)
			.where(sql`dedupe_key IS NOT NULL`)
	]
)

export type EventRow = typeof events.$inferSelect
export type NewEventRow = typeof events.$inferInsert

// -- Agent Bootstrap State ---------------------------------------------------

export const agentBootstrapState = sqliteTable(
	'agent_bootstrap_state',
	{
		agentId: text('agent_id').primaryKey().notNull(),
		status: text('status').notNull().default('pending'),
		workspaceSeededAt: integer('workspace_seeded_at'),
		bootstrapInjectedAt: integer('bootstrap_injected_at'),
		bootstrapInjectedSessionId: text(
			'bootstrap_injected_session_id'
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
		claimedBySessionId: text('claimed_by_session_id'),
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
