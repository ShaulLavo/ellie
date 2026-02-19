import { Elysia } from "elysia"
import {
  createServerContext,
  handleDurableStreamRequest,
} from "@ellie/durable-streams/server"
import { chatRoutes } from "./routes/chat"

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
    .use(chatRoutes(ctx))

  if (enableDurableStreamsApi) {
    app.all(`/streams/*`, async ({ request, params }) => {
      const streamPath = `/${params[`*`]}`
      return handleDurableStreamRequest(ctx, request, streamPath)
    })
  }

  return { app, ctx }
}
