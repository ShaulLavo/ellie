import type { StandardSchemaV1 } from "@standard-schema/spec"

/**
 * Create a typed router definition.
 *
 * The router is the single source of truth for stream schemas.
 * Define it on the server and export `type AppRouter = typeof appRouter`
 * for the client to import.
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
 * export const appRouter = createRouter({
 *   chat: {
 *     path: "/chat/:chatId",
 *     collections: {
 *       messages: {
 *         schema: messageSchema,
 *         type: "message",
 *         primaryKey: "id",
 *       },
 *     },
 *   },
 * })
 *
 * export type AppRouter = typeof appRouter
 * ```
 */
export function createRouter<
  T extends Record<
    string,
    {
      path: string
      collections: Record<
        string,
        {
          schema: StandardSchemaV1<any>
          type: string
          primaryKey: string
        }
      >
    }
  >,
>(definition: T): T {
  // Runtime validation
  for (const [streamName, streamDef] of Object.entries(definition)) {
    if (!streamDef.path) {
      throw new Error(
        `[streams-rpc] Stream "${streamName}" must have a path property`
      )
    }

    // Validate no duplicate event types within a stream
    const seenTypes = new Map<string, string>()
    for (const [collName, collDef] of Object.entries(streamDef.collections)) {
      const existing = seenTypes.get(collDef.type)
      if (existing) {
        throw new Error(
          `[streams-rpc] Duplicate event type "${collDef.type}" in stream "${streamName}": ` +
            `used by both "${existing}" and "${collName}"`
        )
      }
      seenTypes.set(collDef.type, collName)

      if (!collDef.primaryKey) {
        throw new Error(
          `[streams-rpc] Collection "${collName}" in stream "${streamName}" must have a primaryKey`
        )
      }
    }
  }

  return definition
}
