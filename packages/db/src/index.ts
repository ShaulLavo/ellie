import { drizzle } from "drizzle-orm/bun-sqlite"
import * as schema from "./schema"
import { openDatabase } from "./init"
import { initCoreTables } from "./tables"

export type DB = ReturnType<typeof createDB>

/**
 * Create and initialize a raw database at the given path.
 * For direct Drizzle access without the log file layer.
 * Tables are created automatically on first run.
 */
export function createDB(dbPath: string) {
  const sqlite = openDatabase(dbPath)
  const db = drizzle(sqlite, { schema })

  initCoreTables(sqlite)

  return { db, sqlite, schema }
}

// Re-exports
export { openDatabase, isVecAvailable } from "./init"
export { initCoreTables } from "./tables"
export { LogFile, streamPathToFilename } from "./log"
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
