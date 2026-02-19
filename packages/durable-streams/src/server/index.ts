import { handleCreate } from "./routes/create"
import { handleHead } from "./routes/head"
import { handleRead } from "./routes/read"
import { handleAppend } from "./routes/append"
import { handleDelete } from "./routes/delete"
import { handleTestInjectError } from "./routes/test-control"
import { consumeInjectedFault } from "./lib/context"
import type { ServerContext } from "./lib/context"
import { setDurableStreamHeaders } from "./lib/constants"

function applyCorsHeaders(response: Response): Response {
  const h: Record<string, string> = {}
  setDurableStreamHeaders(h)
  for (const [k, v] of Object.entries(h)) {
    response.headers.set(k, String(v))
  }
  return response
}

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
    return applyCorsHeaders(new Response(null, { status: 204 }))
  }

  if (path === `/_test/inject-error`) {
    return applyCorsHeaders(await handleTestInjectError(ctx, request, method))
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
      return applyCorsHeaders(new Response(null, { status: 502 }))
    }

    if (fault.status !== undefined) {
      const headers: Record<string, string> = {
        "content-type": `text/plain`,
      }
      if (fault.retryAfter !== undefined) {
        headers[`retry-after`] = fault.retryAfter.toString()
      }
      return applyCorsHeaders(new Response(`Injected error for testing`, {
        status: fault.status,
        headers,
      }))
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
    let response: Response
    switch (method) {
      case `PUT`:
        response = await handleCreate(ctx, request, path, url)
        break
      case `HEAD`:
        response = handleHead(ctx, path)
        break
      case `GET`:
        response = await handleRead(ctx, request, path, url, bodyFault)
        break
      case `POST`:
        response = await handleAppend(ctx, request, path)
        break
      case `DELETE`:
        response = handleDelete(ctx, path)
        break
      default:
        response = new Response(`Method not allowed`, {
          status: 405,
          headers: { "content-type": `text/plain` },
        })
    }
    return applyCorsHeaders(response)
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes(`not found`)) {
        return applyCorsHeaders(new Response(`Stream not found`, {
          status: 404,
          headers: { "content-type": `text/plain` },
        }))
      }
      if (err.message.includes(`already exists with different configuration`)) {
        return applyCorsHeaders(new Response(`Stream already exists with different configuration`, {
          status: 409,
          headers: { "content-type": `text/plain` },
        }))
      }
      if (err.message.includes(`Sequence conflict`)) {
        return applyCorsHeaders(new Response(`Sequence conflict`, {
          status: 409,
          headers: { "content-type": `text/plain` },
        }))
      }
      if (err.message.includes(`Content-type mismatch`)) {
        return applyCorsHeaders(new Response(`Content-type mismatch`, {
          status: 409,
          headers: { "content-type": `text/plain` },
        }))
      }
      if (err.message.includes(`Invalid JSON`)) {
        return applyCorsHeaders(new Response(`Invalid JSON`, {
          status: 400,
          headers: { "content-type": `text/plain` },
        }))
      }
      if (err.message.includes(`Empty arrays are not allowed`)) {
        return applyCorsHeaders(new Response(`Empty arrays are not allowed`, {
          status: 400,
          headers: { "content-type": `text/plain` },
        }))
      }
    }
    console.error(`Request error:`, err instanceof Error ? err.message : JSON.stringify(err))
    return applyCorsHeaders(new Response(`Internal server error`, {
      status: 500,
      headers: { "content-type": `text/plain` },
    }))
  }
}
