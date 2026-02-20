# RPC Layer

Type-safe RPC framework built on top of Durable Streams. Single router definition drives server handlers, client proxy, and React hooks with full end-to-end type inference.

## Router Definition (Server + Client Shared)

**File**: `packages/router/src/index.ts`

The app-specific router — single source of truth for all stream routes:

```
appRouter = createRouter()
  .stream("chat", "/chat/:chatId", {
    messages: messageSchema
  })
```

**Builder**: `packages/rpc/src/server/router.ts` — fluent `.stream()` method. Validates:
- No duplicate stream names
- No reserved path param names (`value`, `key` — used for mutation payloads)
- No duplicate `type` fields across collections in the same stream

## Type System

**File**: `packages/rpc/src/types.ts`

### Key Types
- `StreamDef<TPath, TCollections>` — path + collection map
- `CollectionDef<TSchema, TType, TPK>` — schema + discriminator type + primary key
- `RpcClient<TRouter>` — fully typed client proxy
- `InferSchema<T>` — extracts output type from any Standard Schema v1

### Path Parameter Extraction
Recursive conditional type parses Express-style paths at the type level:
- `/chat/:chatId` → `{ chatId: string }`
- `/org/:orgId/chat/:chatId` → `{ orgId: string; chatId: string }`

### Collection Normalization
Bare schemas are normalized to full `CollectionDef`:
- `type` defaults to the collection key name (e.g., `"messages"`)
- `primaryKey` defaults to `"id"`

## Client Proxy

**File**: `packages/rpc/src/client/proxy.ts`

`createRpcClient<AppRouter>(router, { baseUrl })` — three-level JS Proxy:

```
rpc                    → Level 1: Stream namespace proxy
rpc.chat               → Level 2: Collection proxy
rpc.chat.messages      → Level 3: Method object with concrete functions
```

### Available Methods (Level 3)

| Method | Signature | What it does |
|--------|-----------|--------------|
| `get` | `(params) → Promise<T[]>` | One-shot read of collection |
| `subscribe` | `(params) → SubscriptionHandle<T>` | Live subscription (ref-counted) |
| `insert` | `(params & { value }) → Promise<void>` | Append insert event |
| `update` | `(params & { value }) → Promise<void>` | Append update event |
| `delete` | `(params & { key }) → Promise<void>` | Append delete event |
| `upsert` | `(params & { value }) → Promise<void>` | Append upsert event |
| `clear` | `(params) → Promise<void>` | Delete stream + recreate fresh |

`params` always includes path params (e.g., `{ chatId: "abc" }`). `value`/`key` are separated via destructuring (why `value`/`key` are reserved param names).

## StreamManager

**File**: `packages/rpc/src/client/manager.ts`

Manages StreamDB instances behind the proxy:

- **Caching**: one StreamDB per resolved path (e.g., `/chat/abc`)
- **Ref counting**: first subscriber creates, last unsubscriber closes + evicts
- **Path resolution**: `/chat/:chatId` + `{ chatId: "abc" }` → `/chat/abc`

### Mutation Flow
1. Resolve path, get/create StreamDB
2. Wait for `ready` (initial sync)
3. Use schema helpers to create a `ChangeEvent`: `{ type, key, value, headers: { operation } }`
4. Append serialized event to stream via `db.stream.append(JSON.stringify(event))`

### Clear Flow
1. `DELETE` the stream on server (soft-delete)
2. Close local StreamDB, evict from cache
3. Immediately recreate fresh StreamDB for the same path
4. Other clients see `deleted` event and auto-reconnect

## React Hook: useStream()

**File**: `packages/rpc/src/client/react.ts`

```
const { data, isLoading, error, insert, update, delete, upsert, clear } =
  useStream(rpc.chat.messages, { chatId }, { orderBy: { field: "createdAt", direction: "asc" } })
```

### Lifecycle
1. `useEffect` calls `collectionClient.subscribe(params)` → gets `SubscriptionHandle`
2. Waits for `handle.ready` → sets `isLoading = false`
3. Uses TanStack DB `useLiveQuery()` for reactive collection data
4. Cleanup calls `handle.unsubscribe()` (decrements ref count)
5. Re-subscribes when `params` change (serialized key comparison)
6. `clear()` bumps a `version` counter to force re-subscribe after server-side delete

### Mutation Helpers
Memoized callbacks that merge path params automatically:
```
insert(value) → collectionClient.insert({ ...params, value })
```

## Server-Side Handler

**File**: `packages/durable-streams/src/server/index.ts`

`handleDurableStreamRequest(ctx, request, streamPath)` dispatches by HTTP method to route handlers in `packages/durable-streams/src/server/routes/`. The RPC layer doesn't add its own server logic — it defines routes and the app maps URL paths to stream paths.

**App routing** (`apps/app/src/routes/streams.ts`):
- `/chat/:id` → `handleDurableStreamRequest(ctx, req, /chat/{id})`
- `/streams/*` → generic transport for any stream path

## End-to-End Type Flow

```
Router definition (Valibot schema)
  ↓ type inference
RpcClient<AppRouter> proxy (typed methods with path params)
  ↓ subscribe / mutate
StreamManager (caching, ref-counting, HTTP transport)
  ↓ events
StreamDB + MaterializedState (TanStack DB collections)
  ↓ useLiveQuery
React component (typed data array)
```

No codegen — pure TypeScript inference from router definition to React props.

## Standard Schema v1

The RPC system is validator-agnostic via Standard Schema v1 spec. This project uses Valibot, but Zod/TypeBox/etc. work too. Output types are inferred at compile time via `InferSchema<T>`.

## Change Event Format

Events appended to streams follow this shape:
```
{ type: "messages", key: "msg-1", value: {...}, headers: { operation: "insert", timestamp: "..." } }
```

`type` is the collection discriminator. `key` is the primary key value. `headers.operation` is one of `insert | update | delete | upsert`. StreamDB replays these to build materialized state.

## Key Files

| What | Where |
|------|-------|
| App router definition | `packages/router/src/index.ts` |
| Router builder | `packages/rpc/src/server/router.ts` |
| Type definitions | `packages/rpc/src/types.ts` |
| Client proxy | `packages/rpc/src/client/proxy.ts` |
| StreamManager | `packages/rpc/src/client/manager.ts` |
| React hook | `packages/rpc/src/client/react.ts` |
| State materialization | `packages/streams-state/src/stream-db.ts` |
| Client singleton | `apps/studio/src/lib/rpc.ts` |
| Chat hook | `apps/studio/src/lib/chat/use-chat.ts` |
