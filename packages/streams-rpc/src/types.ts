import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Collection } from "@tanstack/db"

// ============================================================================
// Schema Inference
// ============================================================================

/**
 * Infer the output type from a Standard Schema (Valibot, Zod, TypeBox, etc.)
 */
export type InferSchema<T> = T extends StandardSchemaV1<any, infer O> ? O : unknown

// ============================================================================
// Path Parameter Extraction
// ============================================================================

/**
 * Extract route params from a path pattern.
 * "/chat/:chatId" → { chatId: string }
 * "/org/:orgId/chat/:chatId" → { orgId: string; chatId: string }
 * "/static" → {}
 */
export type ExtractParams<T extends string> =
  T extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param]: string } & ExtractParams<`/${Rest}`>
    : T extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : {}

/**
 * Check if a path has parameters.
 */
type HasParams<T extends string> = keyof ExtractParams<T> extends never
  ? false
  : true

// ============================================================================
// Collection Definition
// ============================================================================

/**
 * A single collection within a stream.
 * Defines the schema, event type discriminator, and primary key field.
 */
export interface CollectionDef<
  TSchema extends StandardSchemaV1 = StandardSchemaV1,
  TType extends string = string,
  TPK extends string = string,
> {
  schema: TSchema
  type: TType
  primaryKey: TPK
}

// ============================================================================
// Stream Definition
// ============================================================================

/**
 * A stream definition with its URL path pattern and collection definitions.
 *
 * The path supports Express-style params: "/chat/:chatId"
 * Collections define the typed event types within this stream.
 */
export interface StreamDef<
  TPath extends string = string,
  TCollections extends Record<string, CollectionDef> = Record<
    string,
    CollectionDef
  >,
> {
  path: TPath
  collections: TCollections
}

// ============================================================================
// Router Definition
// ============================================================================

/**
 * The router is a record of named stream definitions.
 * This is the single source of truth for types — defined on the server,
 * imported as `type` on the client.
 */
export type RouterDef = Record<string, StreamDef>

/**
 * A router instance that carries its stream definitions.
 * Returned by `createRouter().stream(...).stream(...)`.
 */
export interface Router<T extends RouterDef = RouterDef> {
  readonly _def: T
}

// ============================================================================
// Subscription Handle
// ============================================================================

/**
 * Returned by subscribe(). Wraps a TanStack DB Collection
 * and provides an unsubscribe function for cleanup.
 */
export interface SubscriptionHandle<T> {
  /** The TanStack DB Collection — use with useLiveQuery() for reactive queries */
  collection: Collection<T & object, string>
  /** Decrement ref count and clean up StreamDB when refs reach 0 */
  unsubscribe(): void
  /** Promise that resolves when the stream is synced up-to-date */
  ready: Promise<void>
}

// ============================================================================
// Client-Side Collection API
// ============================================================================

/**
 * The API surface for a single collection on the client.
 * TParams comes from the stream's path pattern.
 *
 * If the stream has no params (e.g., path: "/settings"),
 * the params argument is omitted from all methods.
 */
export type CollectionClient<
  TDef extends CollectionDef,
  TPath extends string,
> = HasParams<TPath> extends true
  ? CollectionClientWithParams<TDef, ExtractParams<TPath>>
  : CollectionClientNoParams<TDef>

interface CollectionClientWithParams<
  TDef extends CollectionDef,
  TParams extends Record<string, string>,
> {
  /** Read the current snapshot of this collection */
  get(params: TParams): Promise<InferSchema<TDef[`schema`]>[]>
  /** Subscribe to live updates, returns a handle with TanStack DB Collection */
  subscribe(params: TParams): SubscriptionHandle<InferSchema<TDef[`schema`]>>
  /** Append an insert event to the stream */
  insert(
    params: TParams & { value: InferSchema<TDef[`schema`]> }
  ): Promise<void>
  /** Append an update event to the stream */
  update(
    params: TParams & { value: InferSchema<TDef[`schema`]> }
  ): Promise<void>
  /** Append a delete event to the stream */
  delete(params: TParams & { key: string }): Promise<void>
  /** Append an upsert event to the stream */
  upsert(
    params: TParams & { value: InferSchema<TDef[`schema`]> }
  ): Promise<void>
  /** Delete the entire stream and all its data */
  clear(params: TParams): Promise<void>
}

interface CollectionClientNoParams<TDef extends CollectionDef> {
  /** Read the current snapshot of this collection */
  get(): Promise<InferSchema<TDef[`schema`]>[]>
  /** Subscribe to live updates, returns a handle with TanStack DB Collection */
  subscribe(): SubscriptionHandle<InferSchema<TDef[`schema`]>>
  /** Append an insert event to the stream */
  insert(params: { value: InferSchema<TDef[`schema`]> }): Promise<void>
  /** Append an update event to the stream */
  update(params: { value: InferSchema<TDef[`schema`]> }): Promise<void>
  /** Append a delete event to the stream */
  delete(params: { key: string }): Promise<void>
  /** Append an upsert event to the stream */
  upsert(params: { value: InferSchema<TDef[`schema`]> }): Promise<void>
  /** Delete the entire stream and all its data */
  clear(): Promise<void>
}

// ============================================================================
// Client-Side Stream API
// ============================================================================

/**
 * The API surface for a stream namespace on the client.
 * Each property is a CollectionClient for that collection,
 * plus a `clear()` method for deleting the entire stream.
 */
export type StreamClient<TDef extends StreamDef> = {
  [K in keyof TDef[`collections`]]: CollectionClient<
    TDef[`collections`][K],
    TDef[`path`]
  >
} & StreamClearMethod<TDef[`path`]>

type StreamClearMethod<TPath extends string> = HasParams<TPath> extends true
  ? { clear(params: ExtractParams<TPath>): Promise<void> }
  : { clear(): Promise<void> }

// ============================================================================
// Full RPC Client
// ============================================================================

/**
 * The fully typed RPC client.
 *
 * For a router like:
 *   { chat: { path: "/chat/:chatId", collections: { messages: { ... } } } }
 *
 * The client type is:
 *   { chat: { messages: CollectionClient<MessagesDef, { chatId: string }> } }
 */
export type RpcClient<T extends RouterDef> = {
  [K in keyof T]: StreamClient<T[K]>
}
