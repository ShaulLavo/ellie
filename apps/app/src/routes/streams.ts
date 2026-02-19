import { Elysia, t } from "elysia"
import {
  handleDurableStreamRequest,
  waitForStoreMessages,
  type ServerContext,
} from "@ellie/durable-streams/server"
import type { TSchema } from "@sinclair/typebox"

const decoder = new TextDecoder()

/**
 * Factory: create a typed Elysia plugin for a named stream.
 *
 * GET returns an async generator — Treaty infers `AsyncGenerator<T>` from the
 * yield type, giving clients full type-safe `for await` consumption.
 * PUT/POST/HEAD/DELETE delegate to the raw durable stream protocol handler.
 */
function createTypedStreamRoute<T extends TSchema>(
  ctx: ServerContext,
  streamPath: string,
  _schema: T,
) {
  const prefix = streamPath.slice(1)
  const handle = (request: Request) =>
    handleDurableStreamRequest(ctx, request, streamPath)

  return new Elysia({ prefix })
    .get(`/`, async function* ({ query }) {
      const offset = query?.offset ?? `-1`
      let currentOffset = offset

      // Catch-up: yield existing messages
      const { messages } = ctx.store.read(streamPath, currentOffset)
      for (const msg of messages) {
        const parsed = JSON.parse(decoder.decode(msg.data))
        currentOffset = msg.offset
        yield parsed
      }

      // Live: subscribe and yield new messages as they arrive
      while (true) {
        const result = await waitForStoreMessages(
          ctx, streamPath, currentOffset, ctx.config.longPollTimeout
        )
        if (result.streamClosed) break
        if (result.timedOut) continue
        for (const msg of result.messages) {
          const parsed = JSON.parse(decoder.decode(msg.data))
          currentOffset = msg.offset
          yield parsed
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
    // ── Named typed routes (Treaty: api.chat.get(), etc.) ───────────
    .use(createTypedStreamRoute(ctx, `/chat`, t.Object({
      role: t.String(),
      content: t.String(),
    })))
    // Add more named routes here as needed:
    // .use(createTypedStreamRoute(ctx, `/presence`, t.Object({...})))

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
