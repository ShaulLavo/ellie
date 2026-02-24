import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

// -- Sessions -----------------------------------------------------------------

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey().notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  currentSeq: integer("current_seq").notNull().default(0),
})

export type SessionRow = typeof sessions.$inferSelect
export type NewSessionRow = typeof sessions.$inferInsert

// -- Events -------------------------------------------------------------------

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    runId: text("run_id"),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    dedupeKey: text("dedupe_key"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_events_session_seq").on(table.sessionId, table.seq),
    index("idx_events_session_type").on(table.sessionId, table.type),
    index("idx_events_session_run_seq").on(
      table.sessionId,
      table.runId,
      table.seq
    ),
  ]
)

export type EventRow = typeof events.$inferSelect
export type NewEventRow = typeof events.$inferInsert
