import type { Database } from "bun:sqlite"

/**
 * Create all core tables with CREATE TABLE IF NOT EXISTS.
 *
 * Single source of truth for table DDL — called by both
 * `createDB()` (raw SQLite access) and `LogStore` (hybrid store).
 *
 * Note: FTS5 and vec0 virtual tables are NOT included here because
 * they are LogStore-specific (drizzle-orm has no virtual table support,
 * so they use raw DDL in LogStore.initTables).
 */
export function initCoreTables(sqlite: Database): void {
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
      last_updated INTEGER NOT NULL,
      PRIMARY KEY (stream_path, producer_id)
    )
  `)
}
