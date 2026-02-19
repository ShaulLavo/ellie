import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { eq, and, gt, sql } from "drizzle-orm"
import { join } from "path"
import { mkdirSync, unlinkSync } from "fs"
import * as schema from "./schema"
import { openDatabase } from "./init"
import { LogFile, streamPathToFilename } from "./log"

/** Resolved path to the drizzle migrations folder shipped with this package. */
const MIGRATIONS_DIR = join(import.meta.dir, "..", "drizzle")

export type JsonlEngineDB = ReturnType<typeof drizzle<typeof schema>>

export interface JsonlMessage {
  data: Uint8Array
  offset: string
  timestamp: number
}

/**
 * Hybrid log store: JSONL files for data, SQLite for index.
 *
 * Write path: append to JSONL file -> insert metadata into SQLite
 * Read path: query SQLite index -> seek into JSONL file
 */
export class JsonlEngine {
  readonly db: JsonlEngineDB
  readonly sqlite: Database
  private logDir: string
  private openLogs = new Map<string, LogFile>()

  constructor(dbPath: string, logDir: string) {
    this.logDir = logDir
    mkdirSync(logDir, { recursive: true })

    console.log(`[engine] init dbPath=${dbPath} logDir=${logDir}`)

    this.sqlite = openDatabase(dbPath)
    this.db = drizzle(this.sqlite, { schema })
    this.initTables()
  }

  // -- Stream operations ----------------------------------------------------

  createStream(
    streamPath: string,
    options: {
      contentType?: string
      ttlSeconds?: number
      expiresAt?: string
    } = {}
  ): schema.StreamRow {
    const now = Date.now()

    // Idempotent insert — returns inserted row, or fetches existing on conflict
    const [inserted] = this.db
      .insert(schema.streams)
      .values({
        path: streamPath,
        contentType: options.contentType,
        ttlSeconds: options.ttlSeconds,
        expiresAt: options.expiresAt,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning()
      .all()

    if (inserted) return inserted

    // Stream already existed — fetch it
    return this.db
      .select()
      .from(schema.streams)
      .where(eq(schema.streams.path, streamPath))
      .get()!
  }

  getStream(streamPath: string): schema.StreamRow | undefined {
    return this.db
      .select()
      .from(schema.streams)
      .where(eq(schema.streams.path, streamPath))
      .get()
  }

  listStreams(): schema.StreamRow[] {
    return this.db.select().from(schema.streams).all()
  }

  deleteStream(streamPath: string): void {
    this.db
      .delete(schema.streams)
      .where(eq(schema.streams.path, streamPath))
      .run()

    // Close and remove the log file handle
    const log = this.openLogs.get(streamPath)
    if (log) {
      log.close()
      this.openLogs.delete(streamPath)
    }

    // Remove the JSONL file from disk
    const filename = streamPathToFilename(streamPath)
    const filePath = join(this.logDir, filename)
    try {
      unlinkSync(filePath)
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e
    }
  }

  // -- Append ---------------------------------------------------------------

  /**
   * Append a message to a stream.
   *
   * 1. Write data to the JSONL file (1 syscall)
   * 2. Insert metadata into SQLite index (no blob, just pointers)
   */
  append(
    streamPath: string,
    data: Uint8Array
  ): { offset: string; bytePos: number; length: number; timestamp: number } {
    const log = this.getOrOpenLog(streamPath)
    const timestamp = Date.now()

    // 1. Write to JSONL file
    const { bytePos, length } = log.append(data)

    // 2. Get current stream offset and compute new one
    const stream = this.db
      .select()
      .from(schema.streams)
      .where(eq(schema.streams.path, streamPath))
      .get()

    if (!stream) {
      throw new Error(`Stream not found: ${streamPath}`)
    }

    const newByteOffset = stream.currentByteOffset + length
    const offset = formatOffset(stream.currentReadSeq, newByteOffset)

    // 3. Insert index entry + update stream offset (single transaction)
    this.db.transaction((tx) => {
      tx.insert(schema.messages)
        .values({ streamPath, bytePos, length, offset, timestamp })
        .run()

      tx.update(schema.streams)
        .set({ currentByteOffset: newByteOffset })
        .where(eq(schema.streams.path, streamPath))
        .run()
    })

    return { offset, bytePos, length, timestamp }
  }

  // -- Read -----------------------------------------------------------------

  /**
   * Read messages from a stream, optionally after a given offset.
   * Uses SQLite index to find byte positions, then reads from JSONL file.
   */
  read(streamPath: string, afterOffset?: string): JsonlMessage[] {
    // Check if stream exists before opening a log file
    const streamExists = this.db
      .select({ path: schema.streams.path })
      .from(schema.streams)
      .where(eq(schema.streams.path, streamPath))
      .get()

    if (!streamExists) return []

    // Query the index
    let rows: schema.MessageRow[]

    if (afterOffset) {
      rows = this.db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.streamPath, streamPath),
            gt(schema.messages.offset, afterOffset)
          )
        )
        .orderBy(schema.messages.offset)
        .all()
    } else {
      rows = this.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.streamPath, streamPath))
        .orderBy(schema.messages.offset)
        .all()
    }

    if (rows.length === 0) return []

    // Only open the log file when we actually have rows to read
    const log = this.getOrOpenLog(streamPath)

    // Read data from the JSONL file
    return rows.map((row) => ({
      data: log.readAt(row.bytePos, row.length),
      offset: row.offset,
      timestamp: row.timestamp,
    }))
  }

  /**
   * Get the current offset for a stream.
   */
  getCurrentOffset(streamPath: string): string | undefined {
    const stream = this.getStream(streamPath)
    if (!stream) return undefined
    return formatOffset(stream.currentReadSeq, stream.currentByteOffset)
  }

  /**
   * Count messages in a stream.
   */
  messageCount(streamPath: string): number {
    const result = this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.messages)
      .where(eq(schema.messages.streamPath, streamPath))
      .get()
    return result?.count ?? 0
  }

  // -- Lifecycle ------------------------------------------------------------

  close(): void {
    for (const log of this.openLogs.values()) {
      log.close()
    }
    this.openLogs.clear()
    this.sqlite.close()
  }

  // -- Private helpers ------------------------------------------------------

  private getOrOpenLog(streamPath: string): LogFile {
    let log = this.openLogs.get(streamPath)
    if (!log) {
      const filename = streamPathToFilename(streamPath)
      const filePath = join(this.logDir, filename)
      log = new LogFile(filePath)
      this.openLogs.set(streamPath, log)
    }
    return log
  }

  private initTables(): void {
    // Core tables — applied via Drizzle migrations (single source of truth: schema.ts)
    migrate(this.db, { migrationsFolder: MIGRATIONS_DIR })

    // TODO: populate messages_fts from the append path and implement full-text search queries
    this.sqlite.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(id, stream_path, content, tokenize='porter')
    `)

    // TODO: populate embeddings from the append path and implement vector similarity search
    try {
      this.sqlite.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_vec
        USING vec0(id INTEGER PRIMARY KEY, embedding float[384])
      `)
    } catch {
      // sqlite-vec not available, skip vector table
    }
  }
}

// -- Offset formatting --------------------------------------------------------

export function formatOffset(readSeq: number, byteOffset: number): string {
  return `${String(readSeq).padStart(16, "0")}_${String(byteOffset).padStart(16, "0")}`
}
