import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { CollectionDef, ProcedureDef, Router, RouterDef, StreamDef } from "../types"

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
 * Fluent router builder — each `.stream()` / verb method call defines an endpoint.
 *
 * Implements `Router<T>` so it can be passed directly to `createRpcClient`
 * without a `.build()` call.
 */
class RouterBuilder<TDefs extends RouterDef>
  implements Router<TDefs>
{
  readonly _def: TDefs

  constructor(defs: TDefs) {
    this._def = defs
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
    TDefs & { [K in SName]: StreamDef<SPath, NormalizeCollections<TInput>> }
  > {
    if (name in this._def) {
      throw new Error(
        `[streams-rpc] Duplicate name "${name}" in router`
      )
    }

    // "value" and "key" are reserved — the proxy client destructures these
    // from the flat params object for mutation payloads.
    const reserved = path.match(/:(?:value|key)\b/g)
    if (reserved) {
      throw new Error(
        `[streams-rpc] Path "${path}" uses reserved param name(s) ${reserved.join(`, `)}. ` +
          `"value" and "key" are used by the RPC client for mutation payloads.`
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
    } as TDefs & {
      [K in SName]: StreamDef<SPath, NormalizeCollections<TInput>>
    }

    return new RouterBuilder(next)
  }

  // ── HTTP verb methods ─────────────────────────────────────────────────

  /** Define a GET procedure. */
  get<
    PName extends string,
    PPath extends string,
    TInput extends StandardSchemaV1,
    TOutput extends StandardSchemaV1,
  >(
    name: PName,
    path: PPath,
    config: { input: TInput; output: TOutput }
  ): RouterBuilder<
    TDefs & { [K in PName]: ProcedureDef<PPath, TInput, TOutput, "GET"> }
  > {
    return addProcedure(this, name, path, config, `GET`)
  }

  /** Define a POST procedure. */
  post<
    PName extends string,
    PPath extends string,
    TInput extends StandardSchemaV1,
    TOutput extends StandardSchemaV1,
  >(
    name: PName,
    path: PPath,
    config: { input: TInput; output: TOutput }
  ): RouterBuilder<
    TDefs & { [K in PName]: ProcedureDef<PPath, TInput, TOutput, "POST"> }
  > {
    return addProcedure(this, name, path, config, `POST`)
  }

  /** Define a PATCH procedure. */
  patch<
    PName extends string,
    PPath extends string,
    TInput extends StandardSchemaV1,
    TOutput extends StandardSchemaV1,
  >(
    name: PName,
    path: PPath,
    config: { input: TInput; output: TOutput }
  ): RouterBuilder<
    TDefs & { [K in PName]: ProcedureDef<PPath, TInput, TOutput, "PATCH"> }
  > {
    return addProcedure(this, name, path, config, `PATCH`)
  }

  /** Define a DELETE procedure. */
  delete<
    PName extends string,
    PPath extends string,
    TInput extends StandardSchemaV1,
    TOutput extends StandardSchemaV1,
  >(
    name: PName,
    path: PPath,
    config: { input: TInput; output: TOutput }
  ): RouterBuilder<
    TDefs & { [K in PName]: ProcedureDef<PPath, TInput, TOutput, "DELETE"> }
  > {
    return addProcedure(this, name, path, config, `DELETE`)
  }
}

// ============================================================================
// Internal Helper
// ============================================================================

function addProcedure<
  TDefs extends RouterDef,
  PName extends string,
  PPath extends string,
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  TMethod extends "POST" | "GET" | "PATCH" | "DELETE",
>(
  builder: RouterBuilder<TDefs>,
  name: PName,
  path: PPath,
  config: { input: TInput; output: TOutput },
  method: TMethod
): RouterBuilder<
  TDefs & { [K in PName]: ProcedureDef<PPath, TInput, TOutput, TMethod> }
> {
  if (name in builder._def) {
    throw new Error(
      `[streams-rpc] Duplicate name "${name}" in router`
    )
  }

  // "input" is reserved — the proxy client destructures { input, ...pathParams }
  const reserved = path.match(/:input\b/g)
  if (reserved) {
    throw new Error(
      `[streams-rpc] Path "${path}" uses reserved param name ":input". ` +
        `"input" is used by the RPC client for procedure payloads.`
    )
  }

  const next = {
    ...builder._def,
    [name]: { path, input: config.input, output: config.output, method },
  } as TDefs & {
    [K in PName]: ProcedureDef<PPath, TInput, TOutput, TMethod>
  }

  return new RouterBuilder(next)
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a typed router definition using fluent method chaining.
 *
 * - `.stream()` defines event-sourced collections backed by durable streams.
 * - `.get()`, `.post()`, `.patch()`, `.delete()` define request/response endpoints.
 *
 * The returned router is passed directly to `createRpcClient` — no `.build()` needed.
 *
 * @example
 * ```typescript
 * import * as v from "valibot"
 * import { createRouter } from "@ellie/rpc/server"
 *
 * export const appRouter = createRouter()
 *   .stream("chat", "/chat/:chatId", {
 *     messages: messageSchema,
 *   })
 *   .post("retain", "/banks/:bankId/retain", {
 *     input: retainInputSchema,
 *     output: retainOutputSchema,
 *   })
 *
 * export type AppRouter = typeof appRouter["_def"]
 * ```
 */
export function createRouter(): RouterBuilder<{}> {
  return new RouterBuilder({})
}
