import { DurableStream, DurableStreamError, FetchStreamTransport } from "@ellie/streams-client"
import {
  createStreamDB,
  createStateSchema,
  type StreamDB,
  type StateSchema,
  type CollectionDefinition,
} from "@ellie/streams-state"
import type { Collection } from "@tanstack/db"
import type { ProcedureDef, StreamDef, SubscriptionHandle } from "../types"

// ============================================================================
// Types
// ============================================================================

interface CacheEntry {
  db: StreamDB<any>
  schema: StateSchema<any>
  refs: number
  ready: Promise<void>
  /** True once the ready promise has settled (resolved or rejected) */
  settled: boolean
  /** True when deleteStream was called while refs > 0 — deferred until last unsubscribe */
  pendingDelete: boolean
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
    resolved = resolved.replaceAll(`:${key}`, encodeURIComponent(value))
  }
  const missing = resolved.match(/:([A-Za-z0-9_]+)/g)
  if (missing) {
    throw new Error(
      `[streams-rpc] Missing params ${missing.join(`, `)} for path "${template}"`
    )
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
    if (entry && !entry.pendingDelete) return entry

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
      .catch((err: unknown) => {
        const isConflict =
          err instanceof DurableStreamError && err.code === `CONFLICT_EXISTS`
        if (!isConflict) throw err
      })
      .then(() => db.preload())

    entry = { db, schema, refs: 0, ready, settled: false, pendingDelete: false }
    const entryRef = entry
    ready.finally(() => { entryRef.settled = true })

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
    return collection.toArray
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
          const cleanup = () => {
            // Re-check: another subscribe may have come in while we waited
            if (entry.refs <= 0) {
              entry.db.close()
              this.#cache.delete(resolvedPath)
            }
          }
          if (entry.pendingDelete || entry.settled) {
            cleanup()
          } else {
            entry.ready.then(cleanup, cleanup)
          }
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
      // Issue HTTP DELETE regardless of ref count
      await entry.db.stream.delete()

      // Always close and evict immediately — the old consumer's long-poll
      // will fail once the stream is deleted. The next #getOrCreate call
      // (from re-render) will create a fresh StreamDB.
      entry.db.close()
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
   * Clear a stream: soft-delete the old log on the server, then immediately
   * re-create a fresh one. All connected clients (including the caller) detect
   * the closure via their consumer and auto-reconnect to the new incarnation.
   */
  async clearStream(
    streamDef: StreamDef,
    params: Record<string, string>
  ): Promise<void> {
    const resolvedPath = resolvePath(streamDef.path, params)
    const entry = this.#cache.get(resolvedPath)

    // Issue HTTP DELETE — the server soft-deletes the stream and notifies
    // all subscribers (including ours) via streamClosed signal.
    if (entry) {
      await entry.db.stream.delete()
    } else {
      const transport = new FetchStreamTransport({
        baseUrl: this.#baseUrl,
        streamId: resolvedPath.replace(/^\//, ``),
      })
      await DurableStream.delete({
        url: `${this.#baseUrl}${resolvedPath}`,
        transport,
      })
    }

    // Re-create the stream on the server so reconnecting consumers find it.
    // We use a one-shot create (not #getOrCreate) to avoid replacing the
    // cached entry — the existing StreamDB's consumer will reconnect itself.
    const transport = new FetchStreamTransport({
      baseUrl: this.#baseUrl,
      streamId: resolvedPath.replace(/^\//, ``),
    })
    await new DurableStream({ url: `${this.#baseUrl}${resolvedPath}`, transport })
      .create({ contentType: `application/json` })
      .catch((err: unknown) => {
        const isConflict =
          err instanceof DurableStreamError && err.code === `CONFLICT_EXISTS`
        if (!isConflict) throw err
      })
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
    if (event == null) {
      throw new Error(
        `[streams-rpc] "${operation}" helper returned ${event} for collection "${collectionName}"`
      )
    }
    await entry.db.stream.append(JSON.stringify(event))
  }

  // --------------------------------------------------------------------------
  // Procedure Calls
  // --------------------------------------------------------------------------

  /**
   * Call a procedure: send an HTTP request and return the parsed response.
   *
   * Destructures `{ input, ...pathParams }` from args.
   * - POST/PATCH: JSON body with input
   * - GET/DELETE: serialize input as query params
   */
  async call(
    procedureDef: ProcedureDef,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const { input, ...pathParams } = args
    const resolvedPath = resolvePath(
      procedureDef.path,
      pathParams as Record<string, string>
    )
    const method = procedureDef.method ?? `POST`
    const url = new URL(`${this.#baseUrl}${resolvedPath}`)

    const init: RequestInit = { method, headers: {} }

    if (method === `GET` || method === `DELETE`) {
      // Serialize input as query params for body-less methods
      if (input != null && typeof input === `object`) {
        for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
          if (v !== undefined) {
            url.searchParams.set(k, String(v))
          }
        }
      }
    } else {
      // POST/PATCH: JSON body
      ;(init.headers as Record<string, string>)[`content-type`] = `application/json`
      init.body = JSON.stringify(input)
    }

    const res = await fetch(url.toString(), init)

    if (!res.ok) {
      const text = await res.text().catch(() => ``)
      throw new Error(
        `[streams-rpc] Procedure call failed: ${method} ${resolvedPath} → ${res.status} ${text}`
      )
    }

    // 204 No Content — return undefined
    if (res.status === 204) return undefined

    const contentType = res.headers.get(`content-type`) ?? ``
    if (contentType.includes(`application/json`)) {
      return res.json()
    }

    return res.text()
  }
}
