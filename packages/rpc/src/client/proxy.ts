import { StreamManager } from "./manager"
import type { Router, RouterDef, RpcClient, StreamDef } from "../types"

// ============================================================================
// Introspection Guard
// ============================================================================

/**
 * Well-known keys that JS runtimes, Promise, React DevTools, and
 * console.log probe on objects. Returning undefined for these prevents
 * the Proxy from throwing when the object is inspected.
 */
const INTROSPECTION_KEYS = new Set([`then`, `toJSON`, `$$typeof`, `valueOf`, `toString`])

function isIntrospectionKey(key: string | symbol): boolean {
  return typeof key === `symbol` || INTROSPECTION_KEYS.has(key as string)
}

// ============================================================================
// Client Options
// ============================================================================

export interface RpcClientOptions {
  /** Base URL of the server (e.g., "http://localhost:4437") */
  baseUrl: string
}

// ============================================================================
// Proxy Implementation
// ============================================================================

/**
 * Create a typed RPC client backed by durable streams.
 *
 * Uses JS Proxy for dynamic property access. The chain
 * `rpc.chat.messages.get({ chatId })` resolves as:
 *   1. `rpc.chat` → Proxy for the "chat" stream namespace
 *   2. `.messages` → Proxy for the "messages" collection
 *   3. `.get({ chatId })` → resolves path, gets/creates StreamDB, reads collection
 *
 * @param router - The router (from `createRouter().stream(...)`) or a plain RouterDef
 * @param options - Client configuration (baseUrl)
 *
 * @example
 * ```typescript
 * import { appRouter, type AppRouter } from "@ellie/router"
 * import { createRpcClient } from "@ellie/rpc/client"
 * import { env } from "@ellie/env/client"
 *
 * const rpc = createRpcClient<AppRouter>(appRouter, {
 *   baseUrl: env.API_BASE_URL,
 * })
 *
 * // One-shot read
 * const messages = await rpc.chat.messages.get({ chatId: "abc" })
 *
 * // Live subscription
 * const handle = rpc.chat.messages.subscribe({ chatId: "abc" })
 * // Use handle.collection with useLiveQuery()
 *
 * // Mutations
 * await rpc.chat.messages.insert({
 *   chatId: "abc",
 *   value: { id: "1", role: "user", content: "hello", createdAt: new Date().toISOString() },
 * })
 * ```
 */
export function createRpcClient<TRouter extends RouterDef>(
  router: Router<TRouter> | TRouter,
  options: RpcClientOptions
): RpcClient<TRouter> {
  const routerDef = (`_def` in router ? router._def : router) as TRouter
  const manager = new StreamManager(options.baseUrl)

  // Level 1: stream namespace proxy (rpc.chat → ...)
  return new Proxy({} as RpcClient<TRouter>, {
    get(_, streamName: string | symbol) {
      if (isIntrospectionKey(streamName)) return undefined
      const streamDef = (routerDef as Record<string, StreamDef>)[streamName as string]
      if (!streamDef) {
        throw new Error(
          `[streams-rpc] Unknown stream "${String(streamName)}" — not defined in router`
        )
      }

      // Level 2: collection proxy (rpc.chat.messages → ...)
      return new Proxy(
        {},
        {
          get(_, collectionName: string | symbol) {
            if (isIntrospectionKey(collectionName)) return undefined

            // Stream-level clear: rpc.chat.clear({ chatId })
            if (collectionName === `clear`) {
              return (params?: Record<string, string>) =>
                manager.clearStream(streamDef, params ?? {})
            }

            const colName = collectionName as string
            if (
              !(colName in streamDef.collections)
            ) {
              throw new Error(
                `[streams-rpc] Unknown collection "${colName}" in stream "${String(streamName)}". ` +
                  `Available: ${Object.keys(streamDef.collections).join(`, `)}`
              )
            }

            // Level 3: method object (rpc.chat.messages.get → fn)
            //
            // ⚠️ Known limitation: path params named "value" or "key" collide with
            // the mutation payload destructure below ({ value, ...rest } / { key, ...rest }).
            // Avoid using "value" or "key" as path param names in router definitions.
            return {
              get(params?: Record<string, string>) {
                return manager.get(streamDef, colName, params ?? {})
              },

              subscribe(params?: Record<string, string>) {
                return manager.subscribe(
                  streamDef,
                  colName,
                  params ?? {}
                )
              },

              insert(params?: Record<string, string> & { value?: unknown }) {
                const { value, ...rest } = params ?? {}
                return manager.mutate(
                  streamDef,
                  colName,
                  `insert`,
                  rest,
                  { value }
                )
              },

              update(params?: Record<string, string> & { value?: unknown }) {
                const { value, ...rest } = params ?? {}
                return manager.mutate(
                  streamDef,
                  colName,
                  `update`,
                  rest,
                  { value }
                )
              },

              delete(params?: Record<string, string> & { key?: string }) {
                const { key, ...rest } = params ?? {}
                return manager.mutate(
                  streamDef,
                  colName,
                  `delete`,
                  rest,
                  { key }
                )
              },

              upsert(params?: Record<string, string> & { value?: unknown }) {
                const { value, ...rest } = params ?? {}
                return manager.mutate(
                  streamDef,
                  colName,
                  `upsert`,
                  rest,
                  { value }
                )
              },

              clear(params?: Record<string, string>) {
                return manager.clearStream(streamDef, params ?? {})
              },
            }
          },
        }
      )
    },
  })
}
