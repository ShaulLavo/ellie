import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { CollectionDef, Router, StreamDef } from "../types"

// ============================================================================
// Collection Input
// ============================================================================

/**
 * What you pass in the collections map:
 * - A bare schema (uses collection name as event type, "id" as primary key)
 * - Or an object with { schema, type?, primaryKey? } for overrides
 */
type CollectionInput =
  | StandardSchemaV1<any>
  | { schema: StandardSchemaV1<any>; type?: string; primaryKey?: string }

/** Normalize a CollectionInput to a CollectionDef */
function toCollectionDef(
  name: string,
  input: CollectionInput
): CollectionDef {
  if (`~standard` in input) {
    // Bare schema — apply defaults
    return { schema: input, type: name, primaryKey: `id` }
  }
  // Config object with { schema, type?, primaryKey? }
  return {
    schema: input.schema,
    type: input.type ?? name,
    primaryKey: input.primaryKey ?? `id`,
  }
}

// ============================================================================
// Type-Level Helpers
// ============================================================================

/**
 * Normalize a user-provided collections map to CollectionDef records.
 * Bare schemas → CollectionDef<TSchema, string, string>
 * Objects with { schema } → CollectionDef<TSchema, string, string>
 */
type NormalizeCollections<T extends Record<string, CollectionInput>> = {
  [K in keyof T]: T[K] extends StandardSchemaV1<any>
    ? CollectionDef<T[K], string, string>
    : T[K] extends { schema: infer S extends StandardSchemaV1<any> }
      ? CollectionDef<S, string, string>
      : never
}

// ============================================================================
// Router Builder
// ============================================================================

/**
 * Fluent router builder — each `.stream()` call defines a complete stream.
 *
 * Implements `Router<T>` so it can be passed directly to `createRpcClient`
 * without a `.build()` call.
 */
class RouterBuilder<TStreams extends Record<string, StreamDef>>
  implements Router<TStreams>
{
  readonly _def: TStreams

  constructor(streams: TStreams) {
    this._def = streams
  }

  /**
   * Define a stream with its path and collections in one call.
   *
   * @param name - Stream namespace (e.g., "chat")
   * @param path - URL path with Express-style params (e.g., "/chat/:chatId")
   * @param collections - Map of collection name → schema (or { schema, type?, primaryKey? })
   */
  stream<
    SName extends string,
    SPath extends string,
    TInput extends Record<string, CollectionInput>,
  >(
    name: SName,
    path: SPath,
    collections: TInput
  ): RouterBuilder<
    TStreams & { [K in SName]: StreamDef<SPath, NormalizeCollections<TInput>> }
  > {
    if (name in this._def) {
      throw new Error(
        `[streams-rpc] Duplicate stream name "${name}" in router`
      )
    }

    // Normalize collection inputs to CollectionDefs
    const normalized: Record<string, CollectionDef> = {}
    const seenTypes = new Map<string, string>()

    for (const [collName, input] of Object.entries(collections)) {
      const def = toCollectionDef(collName, input)

      const existing = seenTypes.get(def.type)
      if (existing) {
        throw new Error(
          `[streams-rpc] Duplicate event type "${def.type}" in stream "${name}": ` +
            `used by both "${existing}" and "${collName}"`
        )
      }
      seenTypes.set(def.type, collName)
      normalized[collName] = def
    }

    const next = {
      ...this._def,
      [name]: { path, collections: normalized },
    } as TStreams & {
      [K in SName]: StreamDef<SPath, NormalizeCollections<TInput>>
    }

    return new RouterBuilder(next)
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a typed router definition using fluent method chaining.
 *
 * Each `.stream()` call defines a complete stream — name, path, and collections.
 * Collections can be a bare schema (defaults: type = collection name, primaryKey = "id")
 * or an object `{ schema, type?, primaryKey? }` for overrides.
 *
 * The returned router is passed directly to `createRpcClient` — no `.build()` needed.
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
 *   .stream("chat", "/chat/:chatId", {
 *     messages: messageSchema,
 *   })
 *   .stream("settings", "/settings", {
 *     prefs: prefSchema,
 *   })
 *
 * export type AppRouter = typeof appRouter["_def"]
 * ```
 */
export function createRouter(): RouterBuilder<{}> {
  return new RouterBuilder({})
}
