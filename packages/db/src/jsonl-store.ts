import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { eq, and, gt, isNull, sql } from "drizzle-orm"
import { join } from "path"
import { mkdirSync } from "fs"
import type { GenericSchema } from "valibot"
import { parse, union } from "valibot"
import { toJsonSchema } from "@valibot/to-json-schema"
import * as schema from "./schema"
import { openDatabase } from "./init"
import { LogFile } from "./log"
import { ulid } from "@ellie/utils"

/** Resolved path to the drizzle migrations folder shipped with this package. */
const MIGRATIONS_DIR = join(import.meta.dir, "..", "drizzle")

const decoder = new TextDecoder()

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
  private schemas = new Map<string, GenericSchema>()
  private schemaPatterns: Array<{ regex: RegExp; schemaKey: string }> = []

  constructor(dbPath: string, logDir: string) {
    this.logDir = logDir
    mkdirSync(logDir, { recursive: true })

    console.log(`[engine] init dbPath=${dbPath} logDir=${logDir}`)

    this.sqlite = openDatabase(dbPath)
    this.db = drizzle(this.sqlite, { schema })
    this.initTables()
  }

  // -- Schema registration --------------------------------------------------

  /**
   * Register a Valibot schema under a key.
   *
   * Stores the schema in memory for append-time validation and persists
   * its JSON Schema representation to the schema_registry table for
   * external tool interop.
   */
  registerSchema(key: string, valibotSchema: GenericSchema, version = 1): void {
    this.schemas.set(key, valibotSchema)

    const jsonSchemaObj = toJsonSchema(valibotSchema)
    const now = Date.now()

    this.db
      .insert(schema.schemaRegistry)
      .values({
        key,
        jsonSchema: JSON.stringify(jsonSchemaObj),
        version,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.schemaRegistry.key,
        set: {
          jsonSchema: JSON.stringify(jsonSchemaObj),
          version,
          updatedAt: now,
        },
      })
      .run()
  }

  /**
   * Get the Valibot schema registered under a key.
   */
  getSchema(key: string): GenericSchema | undefined {
    return this.schemas.get(key)
  }

  /**
   * Get the JSON Schema for a registered key (from SQLite).
   */
  getJsonSchema(key: string): object | undefined {
    const row = this.db
      .select()
      .from(schema.schemaRegistry)
      .where(eq(schema.schemaRegistry.key, key))
      .get()
    return row ? JSON.parse(row.jsonSchema) : undefined
  }

  /**
   * Register all stream definitions from an RPC router.
   *
   * Iterates the router's `_def`, extracts stream definitions (those with
   * `path` + `collections` and no `method`), registers each collection's
   * schema, and builds path-pattern → schemaKey mappings so that
   * `createStream()` can auto-resolve schemas from concrete paths.
   *
   * ```ts
   * engine.registerRouter(appRouter)
   * // Now createStream("/agent/chat-123") auto-enforces agentMessageSchema
   * ```
   */
  registerRouter(router: { _def: Record<string, any> }): void {
    for (const [name, def] of Object.entries(router._def)) {
      // Skip procedure definitions (they have `method`)
      if ("method" in def) continue
      // Stream defs have `path` and `collections`
      if (!def.path || !def.collections) continue

      // Build merged schema from all collections
      const collectionSchemas: GenericSchema[] = []
      for (const col of Object.values(def.collections) as any[]) {
        if (col.schema) collectionSchemas.push(col.schema)
      }

      if (collectionSchemas.length === 0) continue

      const mergedSchema =
        collectionSchemas.length === 1
          ? collectionSchemas[0]!
          : union(collectionSchemas)

      // Register the schema under the stream name
      this.registerSchema(name, mergedSchema)

      // Convert path pattern to regex: /agent/:chatId → ^/agent/[^/]+$
      const regexStr = "^" + def.path.replace(/:[^/]+/g, "[^/]+") + "$"
      this.schemaPatterns.push({ regex: new RegExp(regexStr), schemaKey: name })
    }
  }

  /**
   * Resolve a concrete stream path to a schemaKey using registered patterns.
   */
  private resolveSchemaKey(path: string): string | undefined {
    for (const { regex, schemaKey } of this.schemaPatterns) {
      if (regex.test(path)) return schemaKey
    }
    return undefined
  }

  // -- Stream operations ----------------------------------------------------

  createStream(
    streamPath: string,
    options: {
      contentType?: string
      ttlSeconds?: number
      expiresAt?: string
      schemaKey?: string
    } = {}
  ): schema.StreamRow {
    // Auto-resolve schemaKey from registered router patterns if not explicit
    if (!options.schemaKey) {
      options = { ...options, schemaKey: this.resolveSchemaKey(streamPath) }
    }

    if (options.schemaKey && !this.schemas.has(options.schemaKey)) {
      throw new Error(
        `Schema "${options.schemaKey}" not registered. Call registerSchema() first.`
      )
    }

    const now = Date.now()

    // Idempotent insert — returns inserted row, or fetches existing on conflict
    const [inserted] = this.db
      .insert(schema.streams)
      .values({
        path: streamPath,
        contentType: options.contentType,
        ttlSeconds: options.ttlSeconds,
        expiresAt: options.expiresAt,
        schemaKey: options.schemaKey,
        createdAt: now,
        logFileId: ulid(),
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

    // Stream was deleted/cleared — start fresh with a new JSONL file.
    // New ULID-based logFileId → new file on disk. Old file is orphaned.
    // Wipes messages + producers, bumps currentReadSeq to invalidate old cursors.
    const newLogFileId = ulid()

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
          schemaKey: options.schemaKey ?? null,
          logFileId: newLogFileId,
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

  deleteStream(streamPath: string): void {
    // Soft-delete: mark the stream as deleted.
    // On next createStream() for this path, the stream is wiped and gets a new JSONL file.
    this.db
      .update(schema.streams)
      .set({ deletedAt: Date.now() })
      .where(
        and(eq(schema.streams.path, streamPath), isNull(schema.streams.deletedAt))
      )
      .run()

    // Release the file descriptor
    const log = this.openLogs.get(streamPath)
    if (log) {
      log.close()
      this.openLogs.delete(streamPath)
    }
  }

  // TODO: Implement reaper — background job or CLI command that cleans up
  // soft-deleted streams and their orphaned JSONL files:
  //   1. Find streams where deleted_at older than a retention window
  //   2. Delete orphaned JSONL files from disk using logFileId
  //   3. Hard-DELETE the SQLite row (cascade removes messages/producers)

  // -- Append ---------------------------------------------------------------

  /**
   * Append a message to a stream.
   *
   * If the stream has a schemaKey, the data is decoded, parsed as JSON,
   * and validated against the registered Valibot schema before writing.
   * Invalid records are rejected (throws ValiError).
   *
   * 1. (Optional) Validate against schema
   * 2. Write data to the JSONL file (1 syscall)
   * 3. Insert metadata into SQLite index (no blob, just pointers)
   */
  append(
    streamPath: string,
    data: Uint8Array
  ): { offset: string; bytePos: number; length: number; timestamp: number } {
    // 1. Get stream metadata (needed for offset + schema check)
    const stream = this.db
      .select()
      .from(schema.streams)
      .where(eq(schema.streams.path, streamPath))
      .get()

    if (!stream) {
      throw new Error(`Stream not found: ${streamPath}`)
    }

    // 2. Validate against schema if stream is schema-enforced
    if (stream.schemaKey) {
      const valibotSchema = this.schemas.get(stream.schemaKey)
      if (!valibotSchema) {
        throw new Error(
          `Schema "${stream.schemaKey}" not registered but stream "${streamPath}" requires it.`
        )
      }
      // Strip trailing comma/whitespace before parsing — DurableStore's
      // processJsonAppend appends a comma to each record for JSONL streaming.
      const json = JSON.parse(stripTrailingComma(decoder.decode(data)))
      parse(valibotSchema, json) // throws ValiError on invalid input
    }

    // 3. Write to JSONL file
    const log = this.getOrOpenLog(streamPath)
    const timestamp = Date.now()
    const { bytePos, length } = log.append(data)

    const newByteOffset = stream.currentByteOffset + length
    const offset = formatOffset(stream.currentReadSeq, newByteOffset)

    // 4. Insert index entry + update stream offset (single transaction)
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
      const stream = this.db
        .select({ logFileId: schema.streams.logFileId })
        .from(schema.streams)
        .where(eq(schema.streams.path, streamPath))
        .get()

      if (!stream) {
        throw new Error(`Stream not found: ${streamPath}`)
      }
      if (!stream.logFileId) {
        throw new Error(`Stream has no logFileId: ${streamPath}`)
      }

      const filePath = join(this.logDir, `${stream.logFileId}.jsonl`)
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

// -- Helpers ------------------------------------------------------------------

/**
 * Strip trailing comma and whitespace from a JSON string.
 * DurableStore's processJsonAppend appends a trailing comma to each record
 * for JSONL streaming format. We need to strip it before JSON.parse for
 * schema validation.
 */
function stripTrailingComma(text: string): string {
  let end = text.length
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\n" || text[end - 1] === "\r" || text[end - 1] === "\t")) {
    end--
  }
  if (end > 0 && text[end - 1] === ",") {
    return text.slice(0, end - 1)
  }
  return text
}

// -- Offset formatting --------------------------------------------------------

export function formatOffset(readSeq: number, byteOffset: number): string {
  return `${String(readSeq).padStart(16, "0")}_${String(byteOffset).padStart(16, "0")}`
}
