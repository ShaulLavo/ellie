import { handleCreate } from "./routes/create"
import { handleHead } from "./routes/head"
import { handleRead } from "./routes/read"
import { handleAppend } from "./routes/append"
import { handleDelete } from "./routes/delete"
import { handleTestInjectError } from "./routes/test-control"
import { consumeInjectedFault } from "./lib/context"
import type { ServerContext } from "./lib/context"

export {
  createServerContext,
  consumeInjectedFault,
  type ServerContext,
  type ServerConfig,
  type InjectedFault,
} from "./lib/context"

export { setDurableStreamHeaders } from "./lib/constants"
export { handleCreate } from "./routes/create"
export { handleHead } from "./routes/head"
export { handleRead } from "./routes/read"
export { handleAppend } from "./routes/append"
export { handleDelete } from "./routes/delete"
export { handleTestInjectError } from "./routes/test-control"

/**
 * Handle a raw Durable Streams protocol request.
 * Maps HTTP methods to stream operations (PUT=create, POST=append, GET=read, etc).
 * Includes fault injection support for conformance testing.
 */
export async function handleDurableStreamRequest(
  ctx: ServerContext,
  request: Request,
  streamPath?: string
): Promise<Response> {
  const url = new URL(request.url)
  const path = streamPath ?? url.pathname
  const method = request.method.toUpperCase()

  if (method === `OPTIONS`) {
    return new Response(null, { status: 204 })
  }

  if (path === `/_test/inject-error`) {
    return handleTestInjectError(ctx, request, method)
  }

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
}
