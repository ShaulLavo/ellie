import { Elysia, t } from "elysia"
import {
  handleDurableStreamRequest,
  waitForStoreMessages,
  type ServerContext,
} from "@ellie/durable-streams/server"
import type { TSchema } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import type { StreamMessage } from "@ellie/durable-streams"

const decoder = new TextDecoder()

/**
 * Decode a comma-terminated JSON message and validate against a TypeBox schema.
 * Messages from the store are comma-terminated (e.g. `{"role":"user"},`).
 * Strips the trailing comma before parsing, then checks against the schema.
 */
export function decodeAndValidate<T extends TSchema>(
  msg: StreamMessage,
  schema: T,
): unknown {
  const bytes = msg.data
  // Strip trailing whitespace and comma (store format from processJsonAppend)
  let end = bytes.length
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d || bytes[end - 1] === 0x09)) {
    end--
  }
  if (end > 0 && bytes[end - 1] === 0x2c) {
    end--
  }

  const text = decoder.decode(end === bytes.length ? bytes : bytes.subarray(0, end))
  const parsed: unknown = JSON.parse(text)

  if (!Value.Check(schema, parsed)) {
    const errors = [...Value.Errors(schema, parsed)]
    const detail = errors.length > 0
      ? errors.map((e) => `${e.path}: ${e.message}`).join(`, `)
      : `unknown`
    throw new Error(`Stream message failed schema validation: ${detail}`)
  }

  return parsed
}

/**
 * Factory: create a typed Elysia plugin for a named stream.
 *
 * Two modes:
 *  - **Static** (default): single stream at the prefix path.
 *    GET returns an async generator for direct Treaty `for await` consumption.
 *  - **Parameterized** (`parameterized: true`): `:id` sub-routes.
 *    All methods (including GET) delegate to handleDurableStreamRequest so
 *    TreatyStreamTransport receives raw Response objects with protocol headers.
 *    Treaty shape: `api.chat({ id: "demo" }).get()`, etc.
 */
function createTypedStreamRoute<T extends TSchema>(
  ctx: ServerContext,
  streamPath: string,
  schema: T,
  options?: { parameterized?: boolean },
) {
  const prefix = streamPath.slice(1)

  if (options?.parameterized) {
    const handle = (request: Request, id: string) =>
      handleDurableStreamRequest(ctx, request, `${streamPath}/${id}`)

    return new Elysia({ prefix })
      .get(`/:id`, ({ request, params }) => handle(request, params.id))
      .put(`/:id`, ({ request, params }) => handle(request, params.id))
      .post(`/:id`, ({ request, params }) => handle(request, params.id))
      .head(`/:id`, ({ request, params }) => handle(request, params.id))
      .delete(`/:id`, ({ request, params }) => handle(request, params.id))
  }

  const handle = (request: Request) =>
    handleDurableStreamRequest(ctx, request, streamPath)

  return new Elysia({ prefix })
    .get(`/`, async function* ({ query }) {
      const offset = query?.offset ?? `-1`
      let currentOffset = offset

      // Catch-up: yield existing messages
      const { messages } = ctx.store.read(streamPath, currentOffset)
      for (const msg of messages) {
        yield decodeAndValidate(msg, schema)
        currentOffset = msg.offset
      }

      // Live: subscribe and yield new messages as they arrive
      while (true) {
        const result = await waitForStoreMessages(
          ctx, streamPath, currentOffset, ctx.config.longPollTimeout
        )
        if (result.streamClosed) break
        if (result.timedOut) continue
        for (const msg of result.messages) {
          yield decodeAndValidate(msg, schema)
          currentOffset = msg.offset
        }
      }
    }, {
      query: t.Optional(t.Object({
        offset: t.Optional(t.String()),
      })),
    })
    .put(`/`, ({ request }) => handle(request))
    .post(`/`, ({ request }) => handle(request))
    .head(`/`, ({ request }) => handle(request))
    .delete(`/`, ({ request }) => handle(request))
}

// ── Route registration ──────────────────────────────────────────────

export function streamRoutes(ctx: ServerContext) {
  const handle = (request: Request, path: string) =>
    handleDurableStreamRequest(ctx, request, `/${path}`)

  return new Elysia()
    // ── Named typed routes (Treaty: api.chat({ id }).get(), etc.) ──
    .use(createTypedStreamRoute(ctx, `/chat`, t.Object({
      role: t.String(),
      content: t.String(),
    }), { parameterized: true }))
    // Add more named routes here as needed:
    // .use(createTypedStreamRoute(ctx, `/presence`, presenceSchema, { parameterized: true }))

    // ── Generic transport routes (for TreatyStreamTransport / raw HTTP) ──
    .group(`/streams`, (app) => app
      // Typed :id routes — used by Treaty for type-safe RPC.
      // Stream paths are URL-encoded into a single segment (e.g. chat%2Froom-1).
      // Elysia auto-decodes path params via fastDecodeURIComponent.
      .put(`/:id`, ({ request, params }) => handle(request, params.id))
      .post(`/:id`, ({ request, params }) => handle(request, params.id))
      .get(`/:id`, ({ request, params }) => handle(request, params.id))
      .head(`/:id`, ({ request, params }) => handle(request, params.id))
      .delete(`/:id`, ({ request, params }) => handle(request, params.id))
      // Wildcard catch-all — matches multi-segment paths for raw HTTP clients
      // and backward compatibility (e.g. /streams/v1/stream/my-stream).
      .put(`/*`, ({ request, params }) => handle(request, params[`*`]))
      .post(`/*`, ({ request, params }) => handle(request, params[`*`]))
      .get(`/*`, ({ request, params }) => handle(request, params[`*`]))
      .head(`/*`, ({ request, params }) => handle(request, params[`*`]))
      .delete(`/*`, ({ request, params }) => handle(request, params[`*`]))
    )
}
