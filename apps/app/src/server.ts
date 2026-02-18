import { Elysia } from "elysia"
import {
  createServerContext,
  consumeInjectedFault,
} from "./lib/context"
import { handleCreate } from "./routes/create"
import { handleHead } from "./routes/head"
import { handleRead } from "./routes/read"
import { handleAppend } from "./routes/append"
import { handleDelete } from "./routes/delete"
import { handleTestInjectError } from "./routes/test-control"

export function createDurableStreamServer(options: {
  port?: number
  longPollTimeout?: number
  compression?: boolean
} = {}) {
  const ctx = createServerContext({
    longPollTimeout: options.longPollTimeout,
    compression: options.compression,
  })

  const app = new Elysia()
    .onRequest(({ set }) => {
      // CORS headers
      set.headers[`access-control-allow-origin`] = `*`
      set.headers[`access-control-allow-methods`] =
        `GET, POST, PUT, DELETE, HEAD, OPTIONS`
      set.headers[`access-control-allow-headers`] =
        `content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq`
      set.headers[`access-control-expose-headers`] =
        `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, etag, content-type, content-encoding, vary`
      // Browser security headers
      set.headers[`x-content-type-options`] = `nosniff`
      set.headers[`cross-origin-resource-policy`] = `cross-origin`
    })
    .all(`*`, async ({ request }) => {
      const url = new URL(request.url)
      const path = url.pathname
      const method = request.method.toUpperCase()

      // Handle CORS preflight
      if (method === `OPTIONS`) {
        return new Response(null, { status: 204 })
      }

      // Handle test control endpoints
      if (path === `/_test/inject-error`) {
        return handleTestInjectError(ctx, request, method)
      }

      // Check for injected faults
      const fault = consumeInjectedFault(ctx, path, method)
      if (fault) {
        if (fault.delayMs !== undefined && fault.delayMs > 0) {
          const jitter = fault.jitterMs ? Math.random() * fault.jitterMs : 0
          await new Promise((resolve) =>
            setTimeout(resolve, fault.delayMs! + jitter)
          )
        }

        if (fault.dropConnection) {
          return new Response(null, { status: 502 })
        }

        if (fault.status !== undefined) {
          const headers: Record<string, string> = {
            "content-type": `text/plain`,
          }
          if (fault.retryAfter !== undefined) {
            headers[`retry-after`] = fault.retryAfter.toString()
          }
          return new Response(`Injected error for testing`, {
            status: fault.status,
            headers,
          })
        }
      }

      const bodyFault =
        fault &&
        (fault.truncateBodyBytes !== undefined ||
          fault.corruptBody ||
          fault.injectSseEvent)
          ? fault
          : null

      try {
        switch (method) {
          case `PUT`:
            return handleCreate(ctx, request, path, url)
          case `HEAD`:
            return handleHead(ctx, path)
          case `GET`:
            return handleRead(ctx, request, path, url, bodyFault)
          case `POST`:
            return handleAppend(ctx, request, path)
          case `DELETE`:
            return handleDelete(ctx, path)
          default:
            return new Response(`Method not allowed`, {
              status: 405,
              headers: { "content-type": `text/plain` },
            })
        }
      } catch (err) {
        if (err instanceof Error) {
          if (err.message.includes(`not found`)) {
            return new Response(`Stream not found`, {
              status: 404,
              headers: { "content-type": `text/plain` },
            })
          }
          if (err.message.includes(`already exists with different configuration`)) {
            return new Response(`Stream already exists with different configuration`, {
              status: 409,
              headers: { "content-type": `text/plain` },
            })
          }
          if (err.message.includes(`Sequence conflict`)) {
            return new Response(`Sequence conflict`, {
              status: 409,
              headers: { "content-type": `text/plain` },
            })
          }
          if (err.message.includes(`Content-type mismatch`)) {
            return new Response(`Content-type mismatch`, {
              status: 409,
              headers: { "content-type": `text/plain` },
            })
          }
          if (err.message.includes(`Invalid JSON`)) {
            return new Response(`Invalid JSON`, {
              status: 400,
              headers: { "content-type": `text/plain` },
            })
          }
          if (err.message.includes(`Empty arrays are not allowed`)) {
            return new Response(`Empty arrays are not allowed`, {
              status: 400,
              headers: { "content-type": `text/plain` },
            })
          }
        }
        console.error(`Request error:`, err)
        return new Response(`Internal server error`, {
          status: 500,
          headers: { "content-type": `text/plain` },
        })
      }
    })

  return { app, ctx }
}
