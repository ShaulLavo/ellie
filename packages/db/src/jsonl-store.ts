import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { eq, and, gt, isNull, sql } from "drizzle-orm"
import { join } from "path"
import { mkdirSync } from "fs"
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
      resurrect?: boolean
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

    // Stream already existed — fetch it (including soft-deleted)
    const existing = this.db
      .select()
      .from(schema.streams)
      .where(eq(schema.streams.path, streamPath))
      .get()!

    // If the existing stream is live (not soft-deleted), return it as-is (idempotent)
    if (existing.deletedAt === null || existing.deletedAt === undefined) {
      return existing
    }

    // Stream was soft-deleted — require explicit opt-in to resurrect
    if (!options.resurrect) {
      throw new SoftDeletedError(
        `Stream was deleted at ${new Date(existing.deletedAt).toISOString()}. ` +
          `Pass resurrect: true to reuse this path.`,
        streamPath,
        existing.deletedAt
      )
    }

    // Resurrect: clear old index rows + producer state, reset the stream row.
    // The JSONL file stays on disk. Bumping currentReadSeq makes old offsets
    // unreachable so stale subscribers/cursors can't read previous-incarnation data.
    this.db.transaction((tx) => {
      tx.delete(schema.messages)
        .where(eq(schema.messages.streamPath, streamPath))
        .run()

      tx.delete(schema.producers)
        .where(eq(schema.producers.streamPath, streamPath))
        .run()

      tx.update(schema.streams)
        .set({
          deletedAt: null,
          closed: false,
          closedByProducerId: null,
          closedByEpoch: null,
          closedBySeq: null,
          currentReadSeq: existing.currentReadSeq + 1,
          currentByteOffset: 0,
          createdAt: now,
          contentType: options.contentType ?? null,
          ttlSeconds: options.ttlSeconds ?? null,
          expiresAt: options.expiresAt ?? null,
        })
        .where(eq(schema.streams.path, streamPath))
        .run()
    })

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
      .where(
        and(eq(schema.streams.path, streamPath), isNull(schema.streams.deletedAt))
      )
      .get()
  }

  listStreams(): schema.StreamRow[] {
    return this.db
      .select()
      .from(schema.streams)
      .where(isNull(schema.streams.deletedAt))
      .all()
  }

  // TODO: Implement reaper — background job or CLI command that hard-deletes
  // streams where deleted_at < Date.now() - RETENTION_PERIOD. The reaper would:
  //   1. Find streams with deleted_at older than the retention window
  //   2. DELETE the SQLite row (cascade removes messages/producers)
  //   3. unlinkSync the JSONL file from disk
  deleteStream(streamPath: string): void {
    // Soft-delete: mark the stream as deleted, keep JSONL file on disk
    this.db
      .update(schema.streams)
      .set({ deletedAt: Date.now() })
      .where(
        and(eq(schema.streams.path, streamPath), isNull(schema.streams.deletedAt))
      )
      .run()

    // Release the file descriptor — don't hold handles for dead streams
    const log = this.openLogs.get(streamPath)
    if (log) {
      log.close()
      this.openLogs.delete(streamPath)
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

// -- Errors -------------------------------------------------------------------

export class SoftDeletedError extends Error {
  readonly code = "soft_deleted"
  constructor(
    message: string,
    readonly streamPath: string,
    readonly deletedAt: number
  ) {
    super(message)
    this.name = "SoftDeletedError"
  }
}

// -- Offset formatting --------------------------------------------------------

export function formatOffset(readSeq: number, byteOffset: number): string {
  return `${String(readSeq).padStart(16, "0")}_${String(byteOffset).padStart(16, "0")}`
}
