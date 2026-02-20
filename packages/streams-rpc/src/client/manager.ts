import { DurableStream, FetchStreamTransport } from "@ellie/streams-client"
import {
  createStreamDB,
  createStateSchema,
  type StreamDB,
  type StateSchema,
  type CollectionDefinition,
} from "@ellie/streams-state"
import type { Collection } from "@tanstack/db"
import type { StreamDef, SubscriptionHandle } from "../types"

// ============================================================================
// Types
// ============================================================================

interface CacheEntry {
  db: StreamDB<any>
  schema: StateSchema<any>
  refs: number
  ready: Promise<void>
}

type Operation = `insert` | `update` | `delete` | `upsert`

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolve a path template with params.
 * "/chat/:chatId" + { chatId: "abc" } → "/chat/abc"
 */
function resolvePath(
  template: string,
  params: Record<string, string>
): string {
  let resolved = template
  for (const [key, value] of Object.entries(params)) {
    resolved = resolved.replace(`:${key}`, encodeURIComponent(value))
  }
  return resolved
}

// ============================================================================
// StreamManager
// ============================================================================

/**
 * Manages StreamDB instances with ref counting.
 * Keyed by resolved stream path (e.g., "/chat/abc").
 *
 * - get(): one-shot read — returns snapshot after stream syncs
 * - subscribe(): increment ref, return TanStack DB Collection + unsubscribe
 * - mutate(): append a ChangeEvent to the stream
 */
export class StreamManager {
  readonly #baseUrl: string
  readonly #cache = new Map<string, CacheEntry>()

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, ``)
  }

  // --------------------------------------------------------------------------
  // Internal: get or create a StreamDB for a resolved path
  // --------------------------------------------------------------------------

  #getOrCreate(
    streamDef: StreamDef,
    params: Record<string, string>
  ): CacheEntry {
    const resolvedPath = resolvePath(streamDef.path, params)
    let entry = this.#cache.get(resolvedPath)
    if (entry) return entry

    const transport = new FetchStreamTransport({
      baseUrl: this.#baseUrl,
      streamId: resolvedPath.replace(/^\//, ``),
    })

    // Convert router collection defs to the format createStateSchema expects
    const stateDefs: Record<string, CollectionDefinition> = {}
    for (const [name, def] of Object.entries(streamDef.collections)) {
      stateDefs[name] = {
        schema: def.schema,
        type: def.type,
        primaryKey: def.primaryKey,
      }
    }

    const schema = createStateSchema(stateDefs)

    const db = createStreamDB({
      streamOptions: {
        url: `${this.#baseUrl}${resolvedPath}`,
        contentType: `application/json`,
        transport,
      },
      state: schema,
    })

    // Auto-create stream on first use, then preload
    const ready = db.stream
      .create({ contentType: `application/json` })
      .catch(() => {
        // Ignore "already exists" errors
      })
      .then(() => db.preload())

    entry = { db, schema, refs: 0, ready }
    this.#cache.set(resolvedPath, entry)
    return entry
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * One-shot read: sync stream to up-to-date, return snapshot as array.
   */
  async get(
    streamDef: StreamDef,
    collectionName: string,
    params: Record<string, string>
  ): Promise<unknown[]> {
    const entry = this.#getOrCreate(streamDef, params)
    await entry.ready
    const collection = (entry.db.collections as Record<string, Collection<object, string>>)[
      collectionName
    ]
    if (!collection) {
      throw new Error(
        `[streams-rpc] Collection "${collectionName}" not found in stream`
      )
    }
    return Array.from(collection)
  }

  /**
   * Subscribe: increment ref count, return TanStack DB Collection + unsubscribe.
   */
  subscribe(
    streamDef: StreamDef,
    collectionName: string,
    params: Record<string, string>
  ): SubscriptionHandle<any> {
    const entry = this.#getOrCreate(streamDef, params)
    entry.refs++

    const collection = (entry.db.collections as Record<string, Collection<object, string>>)[
      collectionName
    ]
    if (!collection) {
      throw new Error(
        `[streams-rpc] Collection "${collectionName}" not found in stream`
      )
    }

    const resolvedPath = resolvePath(streamDef.path, params)

    return {
      collection,
      ready: entry.ready,
      unsubscribe: () => {
        entry.refs--
        if (entry.refs <= 0) {
          entry.db.close()
          this.#cache.delete(resolvedPath)
        }
      },
    }
  }

  /**
   * Delete an entire stream: issue HTTP DELETE, close StreamDB, evict from cache.
   * After this call, the next subscribe/get will auto-create a fresh stream.
   */
  async deleteStream(
    streamDef: StreamDef,
    params: Record<string, string>
  ): Promise<void> {
    const resolvedPath = resolvePath(streamDef.path, params)
    const entry = this.#cache.get(resolvedPath)

    if (entry) {
      // Use the existing DurableStream instance to issue HTTP DELETE
      await entry.db.stream.delete()
      // Close StreamDB (aborts subscription, rejects pending promises)
      entry.db.close()
      // Evict from cache so next access creates a fresh stream
      this.#cache.delete(resolvedPath)
    } else {
      // No cached entry — use static DurableStream.delete() for a one-shot delete
      const transport = new FetchStreamTransport({
        baseUrl: this.#baseUrl,
        streamId: resolvedPath.replace(/^\//, ``),
      })
      await DurableStream.delete({
        url: `${this.#baseUrl}${resolvedPath}`,
        transport,
      })
    }
  }

  /**
   * Mutate: append a ChangeEvent to the stream.
   */
  async mutate(
    streamDef: StreamDef,
    collectionName: string,
    operation: Operation,
    params: Record<string, string>,
    payload: { value?: unknown; key?: string }
  ): Promise<void> {
    const entry = this.#getOrCreate(streamDef, params)
    await entry.ready

    const helpers = (entry.schema as Record<string, any>)[collectionName]
    if (!helpers || typeof helpers[operation] !== `function`) {
      throw new Error(
        `[streams-rpc] No "${operation}" helper for collection "${collectionName}"`
      )
    }

    const event = helpers[operation](payload)
    await entry.db.stream.append(JSON.stringify(event))
  }
}
