import { StreamManager } from "./manager"
import type { RouterDef, RpcClient, StreamDef } from "../types"

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
 * @param routerDef - The router definition (import the runtime value from server)
 * @param options - Client configuration (baseUrl)
 *
 * @example
 * ```typescript
 * import { appRouter, type AppRouter } from "app/src/rpc/router"
 * import { createRpcClient } from "@ellie/streams-rpc/client"
 *
 * const rpc = createRpcClient<AppRouter>(appRouter, {
 *   baseUrl: window.location.origin,
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
  routerDef: TRouter,
  options: RpcClientOptions
): RpcClient<TRouter> {
  const manager = new StreamManager(options.baseUrl)

  // Level 1: stream namespace proxy (rpc.chat → ...)
  return new Proxy({} as RpcClient<TRouter>, {
    get(_, streamName: string) {
      const streamDef = (routerDef as Record<string, StreamDef>)[streamName]
      if (!streamDef) {
        throw new Error(
          `[streams-rpc] Unknown stream "${streamName}" — not defined in router`
        )
      }

      // Level 2: collection proxy (rpc.chat.messages → ...)
      return new Proxy(
        {},
        {
          get(_, collectionName: string) {
            // Stream-level clear: rpc.chat.clear({ chatId })
            if (collectionName === `clear`) {
              return (params?: Record<string, string>) =>
                manager.deleteStream(streamDef, params ?? {})
            }

            if (
              !(collectionName in streamDef.collections)
            ) {
              throw new Error(
                `[streams-rpc] Unknown collection "${collectionName}" in stream "${streamName}". ` +
                  `Available: ${Object.keys(streamDef.collections).join(`, `)}`
              )
            }

            // Level 3: method object (rpc.chat.messages.get → fn)
            return {
              get(params?: Record<string, string>) {
                return manager.get(streamDef, collectionName, params ?? {})
              },

              subscribe(params?: Record<string, string>) {
                return manager.subscribe(
                  streamDef,
                  collectionName,
                  params ?? {}
                )
              },

              insert(params?: Record<string, string> & { value?: unknown }) {
                const { value, ...rest } = params ?? {}
                return manager.mutate(
                  streamDef,
                  collectionName,
                  `insert`,
                  rest,
                  { value }
                )
              },

              update(params?: Record<string, string> & { value?: unknown }) {
                const { value, ...rest } = params ?? {}
                return manager.mutate(
                  streamDef,
                  collectionName,
                  `update`,
                  rest,
                  { value }
                )
              },

              delete(params?: Record<string, string> & { key?: string }) {
                const { key, ...rest } = params ?? {}
                return manager.mutate(
                  streamDef,
                  collectionName,
                  `delete`,
                  rest,
                  { key }
                )
              },

              upsert(params?: Record<string, string> & { value?: unknown }) {
                const { value, ...rest } = params ?? {}
                return manager.mutate(
                  streamDef,
                  collectionName,
                  `upsert`,
                  rest,
                  { value }
                )
              },

              clear(params?: Record<string, string>) {
                return manager.deleteStream(streamDef, params ?? {})
              },
            }
          },
        }
      )
    },
  })
}
