import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as schema from "./schema"
import { openDatabase, isVecAvailable } from "./init"

export type DB = ReturnType<typeof createDB>

/**
 * Create and initialize a raw database at the given path.
 * For direct Drizzle access without the log file layer.
 * Tables are created automatically on first run.
 */
export function createDB(dbPath: string) {
  const sqlite = openDatabase(dbPath)
  const db = drizzle(sqlite, { schema })

  initTables(sqlite)

  return { db, sqlite, schema }
}

/**
 * Create all tables with CREATE TABLE IF NOT EXISTS.
 * Same pattern as bot's initMetaDB() — no drizzle-kit push at runtime.
 */
function initTables(sqlite: Database): void {
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS streams (
      path TEXT PRIMARY KEY,
      content_type TEXT,
      ttl_seconds INTEGER,
      expires_at TEXT,
      created_at INTEGER NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0,
      closed_by_producer_id TEXT,
      closed_by_epoch INTEGER,
      closed_by_seq INTEGER,
      current_read_seq INTEGER NOT NULL DEFAULT 0,
      current_byte_offset INTEGER NOT NULL DEFAULT 0
    )
  `)

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_path TEXT NOT NULL REFERENCES streams(path) ON DELETE CASCADE,
      byte_pos INTEGER NOT NULL,
      length INTEGER NOT NULL,
      offset TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `)

  sqlite.run(
    `CREATE INDEX IF NOT EXISTS idx_messages_stream_offset ON messages(stream_path, offset)`
  )

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS producers (
      stream_path TEXT NOT NULL REFERENCES streams(path) ON DELETE CASCADE,
      producer_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      last_seq INTEGER NOT NULL,
      last_updated INTEGER NOT NULL
    )
  `)

  sqlite.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_producers_pk ON producers(stream_path, producer_id)`
  )
}

// Re-exports
export { openDatabase, isVecAvailable } from "./init"
export { LogFile, streamPathToFilename } from "./log"
export { LogStore, formatOffset } from "./log-store"
export type { LogMessage } from "./log-store"
export { typedLog } from "./typed-log"
export type { TypedLog, TypedLogRecord, TypedLogReadOptions } from "./typed-log"
export * as schema from "./schema"
export type {
  StreamRow,
  NewStreamRow,
  MessageRow,
  NewMessageRow,
  ProducerRow,
  NewProducerRow,
} from "./schema"
