import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

// ── Stream metadata ──────────────────────────────────────────────────────────

export const streams = sqliteTable("streams", {
  path: text("path").primaryKey(),
  contentType: text("content_type"),
  ttlSeconds: integer("ttl_seconds"),
  expiresAt: text("expires_at"),
  createdAt: integer("created_at").notNull(),
  closed: integer("closed", { mode: "boolean" }).notNull().default(false),
  closedByProducerId: text("closed_by_producer_id"),
  closedByEpoch: integer("closed_by_epoch"),
  closedBySeq: integer("closed_by_seq"),
  currentReadSeq: integer("current_read_seq").notNull().default(0),
  currentByteOffset: integer("current_byte_offset").notNull().default(0),
})

// ── Stream messages (append-only log) ────────────────────────────────────────

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    streamPath: text("stream_path")
      .notNull()
      .references(() => streams.path, { onDelete: "cascade" }),
    bytePos: integer("byte_pos").notNull(),
    length: integer("length").notNull(),
    offset: text("offset").notNull(),
    timestamp: integer("timestamp").notNull(),
  },
  (table) => [
    index("idx_messages_stream_offset").on(table.streamPath, table.offset),
  ]
)

// ── Producer state (idempotency tracking) ────────────────────────────────────

export const producers = sqliteTable(
  "producers",
  {
    streamPath: text("stream_path")
      .notNull()
      .references(() => streams.path, { onDelete: "cascade" }),
    producerId: text("producer_id").notNull(),
    epoch: integer("epoch").notNull(),
    lastSeq: integer("last_seq").notNull(),
    lastUpdated: integer("last_updated").notNull(),
  },
  (table) => [
    uniqueIndex("idx_producers_pk").on(table.streamPath, table.producerId),
  ]
)

// ── Type exports ─────────────────────────────────────────────────────────────

export type StreamRow = typeof streams.$inferSelect
export type NewStreamRow = typeof streams.$inferInsert
export type MessageRow = typeof messages.$inferSelect
export type NewMessageRow = typeof messages.$inferInsert
export type ProducerRow = typeof producers.$inferSelect
export type NewProducerRow = typeof producers.$inferInsert
