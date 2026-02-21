import { useEffect, useState, useCallback } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import type { Collection } from "@tanstack/db"
import type { SubscriptionHandle } from "../types"

// ============================================================================
// Helpers
// ============================================================================

/** Deterministic serialization — sorted keys so insertion order doesn't matter */
function stableStringify(obj: Record<string, string>): string {
  const keys = Object.keys(obj).sort()
  return JSON.stringify(keys.map((k) => [k, obj[k]]))
}

// ============================================================================
// useStream Hook
// ============================================================================

/**
 * Subscribe to a collection from the RPC client, with automatic lifecycle management.
 *
 * - Calls subscribe() on mount → creates/reuses StreamDB, increments ref count
 * - Calls unsubscribe() on unmount → decrements ref count, cleans up when 0
 * - Uses useLiveQuery() internally for reactive updates
 * - Returns typed data array + mutation helpers
 *
 * @example
 * ```typescript
 * import { createRpcClient } from "@ellie/rpc/client"
 * import { useStream } from "@ellie/rpc/react"
 * import { appRouter, type AppRouter } from "@ellie/router"
 *
 * const rpc = createRpcClient<AppRouter>(appRouter, { baseUrl: origin })
 *
 * function ChatMessages({ chatId }: { chatId: string }) {
 *   const { data, isLoading, insert } = useStream(
 *     rpc.chat.messages,
 *     { chatId }
 *   )
 *
 *   const send = async (content: string) => {
 *     await insert({
 *       id: crypto.randomUUID(),
 *       role: "user",
 *       content,
 *       createdAt: new Date().toISOString(),
 *     })
 *   }
 *
 *   if (isLoading) return <div>Loading...</div>
 *   return <div>{data.map(m => <p key={m.id}>{m.content}</p>)}</div>
 * }
 * ```
 */
export function useStream<
  TItem,
  TParams extends Record<string, string>,
>(
  collectionClient: {
    subscribe(params: TParams): SubscriptionHandle<TItem>
    insert(params: TParams & { value: TItem }): Promise<void>
    update(params: TParams & { value: TItem }): Promise<void>
    delete(params: TParams & { key: string }): Promise<void>
    upsert(params: TParams & { value: TItem }): Promise<void>
    clear(params: TParams): Promise<void>
  },
  params: TParams,
  options?: {
    orderBy?: { field: keyof TItem & string; direction?: `asc` | `desc` }
  }
) {
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [collection, setCollection] = useState<Collection<
    TItem & object,
    string
  > | null>(null)
  // Serialize params for dependency tracking (sorted keys for stability)
  const paramsKey = stableStringify(params)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)

    const handle = collectionClient.subscribe(params)
    setCollection(handle.collection as Collection<TItem & object, string>)

    handle.ready
      .then(() => {
        if (!cancelled) setIsLoading(false)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err : new Error(`Failed to sync stream`)
          )
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
      handle.unsubscribe()
      setCollection(null)
    }
    // collectionClient is a Proxy — fresh object on every render, can't be in deps.
    // paramsKey captures the serialized params which is what actually drives re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey])

  // Memoize orderBy config to keep useLiveQuery deps stable
  const orderByField = options?.orderBy?.field
  const orderByDirection = options?.orderBy?.direction ?? `asc`

  // Live query: reactively subscribe to the TanStack DB collection
  const { data } = useLiveQuery(
    (q) => {
      if (!collection) return null
      const query = q.from({ items: collection })
      if (orderByField) {
        return query.orderBy(({ items }) => (items as Record<string, unknown>)[orderByField], orderByDirection)
      }
      return query
    },
    [collection, orderByField, orderByDirection]
  )

  // Mutation helpers — merge params automatically.
  // collectionClient + params excluded from deps: Proxy creates fresh objects each
  // render, paramsKey is the stable serialized equivalent. See useEffect above.
  const insert = useCallback(
    async (value: TItem) => {
      await collectionClient.insert({ ...params, value } as TParams & {
        value: TItem
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paramsKey]
  )

  const update = useCallback(
    async (value: TItem) => {
      await collectionClient.update({ ...params, value } as TParams & {
        value: TItem
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paramsKey]
  )

  const del = useCallback(
    async (key: string) => {
      await collectionClient.delete({ ...params, key } as TParams & {
        key: string
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paramsKey]
  )

  const upsert = useCallback(
    async (value: TItem) => {
      await collectionClient.upsert({ ...params, value } as TParams & {
        value: TItem
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paramsKey]
  )

  const clear = useCallback(
    async () => {
      await collectionClient.clear(params)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paramsKey]
  )

  return {
    data: (data ?? []) as TItem[],
    isLoading,
    error,
    insert,
    update,
    delete: del,
    upsert,
    clear,
  }
}
