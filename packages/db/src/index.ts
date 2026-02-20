import { join } from "path"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import * as schema from "./schema"
import { openDatabase } from "./init"

/** Resolved path to the drizzle migrations folder shipped with this package. */
const MIGRATIONS_DIR = join(import.meta.dir, "..", "drizzle")

export type DB = ReturnType<typeof createDB>

/**
 * Create and initialize a raw database at the given path.
 * For direct Drizzle access without the log file layer.
 * Tables are created automatically on first run via Drizzle migrations.
 */
export function createDB(dbPath: string) {
  const sqlite = openDatabase(dbPath)
  const db = drizzle(sqlite, { schema })

  migrate(db, { migrationsFolder: MIGRATIONS_DIR })

  return { db, sqlite, schema }
}

// Re-exports
export { openDatabase, isVecAvailable } from "./init"
export { MIGRATIONS_DIR }
export { LogFile } from "./log"
export { JsonlEngine, formatOffset } from "./jsonl-store"
export type { JsonlMessage } from "./jsonl-store"
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
