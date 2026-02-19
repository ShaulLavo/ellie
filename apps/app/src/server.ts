import { Elysia } from "elysia"
import {
  createServerContext,
  handleDurableStreamRequest,
} from "@ellie/durable-streams/server"
import { handleChatRequest } from "./routes/chat"

export function createDurableStreamServer(options: {
  port?: number
  longPollTimeout?: number
  compression?: boolean
  enableDurableStreamsApi?: boolean
} = {}) {
  const ctx = createServerContext({
    longPollTimeout: options.longPollTimeout,
    compression: options.compression,
  })

  const enableDurableStreamsApi =
    options.enableDurableStreamsApi ?? Bun.env.NODE_ENV !== `production`

  const app = new Elysia()
    .onRequest(({ set }) => {
      set.headers[`access-control-allow-origin`] = `*`
      set.headers[`access-control-allow-methods`] =
        `GET, POST, PUT, DELETE, HEAD, OPTIONS`
      set.headers[`access-control-allow-headers`] =
        `content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq`
      set.headers[`access-control-expose-headers`] =
        `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, etag, content-type, content-encoding, vary`
      set.headers[`x-content-type-options`] = `nosniff`
      set.headers[`cross-origin-resource-policy`] = `cross-origin`
    })
    .all(`*`, async ({ request }) => {
      const url = new URL(request.url)
      const path = url.pathname
      const method = request.method.toUpperCase()

      if (method === `OPTIONS`) {
        return new Response(null, { status: 204 })
      }

      // Chat routes (always enabled)
      if (path.startsWith(`/chat/`)) {
        return handleChatRequest(ctx, request, path, method)
      }

      // Durable Streams raw protocol (dev/test only)
      if (!enableDurableStreamsApi) {
        return new Response(`Not found`, {
          status: 404,
          headers: { "content-type": `text/plain` },
        })
      }

      return handleDurableStreamRequest(ctx, request)
    })

  return { app, ctx }
}
