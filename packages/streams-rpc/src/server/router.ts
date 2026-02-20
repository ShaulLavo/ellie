import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { CollectionDef, StreamDef } from "../types"

// ============================================================================
// Builder Types
// ============================================================================

interface CollectionOptions {
  /** Event type discriminator. Defaults to the collection name. */
  type?: string
  /** Primary key field name. Defaults to "id". */
  primaryKey?: string
}

/**
 * Stream builder — accumulates collections for a single stream.
 */
class StreamBuilder<
  TPath extends string,
  TCollections extends Record<string, CollectionDef>,
  TStreams extends Record<string, StreamDef>,
  TName extends string,
> {
  readonly #name: TName
  readonly #path: TPath
  readonly #collections: TCollections
  readonly #router: RouterBuilder<TStreams>

  constructor(
    name: TName,
    path: TPath,
    collections: TCollections,
    router: RouterBuilder<TStreams>
  ) {
    this.#name = name
    this.#path = path
    this.#collections = collections
    this.#router = router
  }

  /**
   * Add a collection to this stream.
   *
   * @param name - Collection name (e.g., "messages")
   * @param schema - Valibot/Zod/TypeBox schema (StandardSchemaV1)
   * @param options - Optional: type (defaults to name), primaryKey (defaults to "id")
   */
  collection<
    CName extends string,
    TSchema extends StandardSchemaV1<any>,
  >(
    name: CName,
    schema: TSchema,
    options?: CollectionOptions
  ): StreamBuilder<
    TPath,
    TCollections & {
      [K in CName]: CollectionDef<TSchema, string, string>
    },
    TStreams,
    TName
  > {
    const def: CollectionDef<TSchema, string, string> = {
      schema,
      type: options?.type ?? name,
      primaryKey: options?.primaryKey ?? `id`,
    }

    const next = {
      ...this.#collections,
      [name]: def,
    } as TCollections & { [K in CName]: CollectionDef<TSchema, string, string> }

    return new StreamBuilder(this.#name, this.#path, next, this.#router)
  }

  /**
   * Start a new stream definition. Finalizes the current stream.
   */
  stream<SName extends string, SPath extends string>(
    name: SName,
    path: SPath
  ): StreamBuilder<
    SPath,
    {},
    TStreams & { [K in TName]: StreamDef<TPath, TCollections> },
    SName
  > {
    const merged = this.#router._addStream(
      this.#name,
      this.#path,
      this.#collections
    )
    return new StreamBuilder(name, path, {} as {}, merged) as any
  }

  /**
   * Finalize the router definition.
   */
  build(): TStreams & { [K in TName]: StreamDef<TPath, TCollections> } {
    const router = this.#router._addStream(
      this.#name,
      this.#path,
      this.#collections
    )
    return router._build() as any
  }
}

// ============================================================================
// Router Builder
// ============================================================================

/**
 * Router builder — accumulates stream definitions.
 */
class RouterBuilder<TStreams extends Record<string, StreamDef>> {
  readonly #streams: TStreams

  constructor(streams: TStreams) {
    this.#streams = streams
  }

  /**
   * Define a new stream.
   *
   * @param name - Stream name used as the namespace (e.g., "chat")
   * @param path - URL path pattern with Express-style params (e.g., "/chat/:chatId")
   */
  stream<SName extends string, SPath extends string>(
    name: SName,
    path: SPath
  ): StreamBuilder<SPath, {}, TStreams, SName> {
    return new StreamBuilder(name, path, {} as {}, this)
  }

  /** @internal — used by StreamBuilder to finalize a stream */
  _addStream<
    SName extends string,
    SPath extends string,
    SCollections extends Record<string, CollectionDef>,
  >(
    name: SName,
    path: SPath,
    collections: SCollections
  ): RouterBuilder<TStreams & { [K in SName]: StreamDef<SPath, SCollections> }> {
    const streamDef = { path, collections }

    // Runtime validation: no duplicate event types
    const seenTypes = new Map<string, string>()
    for (const [collName, collDef] of Object.entries(collections)) {
      const existing = seenTypes.get(collDef.type)
      if (existing) {
        throw new Error(
          `[streams-rpc] Duplicate event type "${collDef.type}" in stream "${name}": ` +
            `used by both "${existing}" and "${collName}"`
        )
      }
      seenTypes.set(collDef.type, collName)
    }

    const next = { ...this.#streams, [name]: streamDef } as TStreams & {
      [K in SName]: StreamDef<SPath, SCollections>
    }
    return new RouterBuilder(next)
  }

  /** @internal — used by StreamBuilder.build() */
  _build(): TStreams {
    return this.#streams
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a typed router definition using a fluent builder.
 *
 * @example
 * ```typescript
 * import * as v from "valibot"
 * import { createRouter } from "@ellie/streams-rpc/server"
 *
 * const messageSchema = v.object({
 *   id: v.string(),
 *   role: v.picklist(["user", "assistant", "system"]),
 *   content: v.string(),
 *   createdAt: v.string(),
 * })
 *
 * export const appRouter = createRouter()
 *   .stream("chat", "/chat/:chatId")
 *     .collection("messages", messageSchema)
 *   .build()
 *
 * export type AppRouter = typeof appRouter
 * ```
 */
export function createRouter(): RouterBuilder<{}> {
  return new RouterBuilder({} as {})
}
