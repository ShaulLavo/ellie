import type { ServerContext } from "../lib/context"

export async function handleTestInjectError(
  ctx: ServerContext,
  request: Request,
  method: string
): Promise<Response> {
  if (method === `POST`) {
    try {
      const config = (await request.json()) as {
        path: string
        status?: number
        count?: number
        retryAfter?: number
        delayMs?: number
        dropConnection?: boolean
        truncateBodyBytes?: number
        probability?: number
        method?: string
        corruptBody?: boolean
        jitterMs?: number
        injectSseEvent?: { eventType: string; data: string }
      }

      if (!config.path) {
        return new Response(`Missing required field: path`, {
          status: 400,
          headers: { "content-type": `text/plain` },
        })
      }

      const hasFaultType =
        config.status !== undefined ||
        config.delayMs !== undefined ||
        config.dropConnection ||
        config.truncateBodyBytes !== undefined ||
        config.corruptBody ||
        config.injectSseEvent !== undefined
      if (!hasFaultType) {
        return new Response(
          `Must specify at least one fault type: status, delayMs, dropConnection, truncateBodyBytes, corruptBody, or injectSseEvent`,
          { status: 400, headers: { "content-type": `text/plain` } }
        )
      }

      ctx.injectedFaults.set(config.path, {
        status: config.status,
        count: config.count ?? 1,
        retryAfter: config.retryAfter,
        delayMs: config.delayMs,
        dropConnection: config.dropConnection,
        truncateBodyBytes: config.truncateBodyBytes,
        probability: config.probability,
        method: config.method,
        corruptBody: config.corruptBody,
        jitterMs: config.jitterMs,
        injectSseEvent: config.injectSseEvent,
      })

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": `application/json` },
      })
    } catch {
      return new Response(`Invalid JSON body`, {
        status: 400,
        headers: { "content-type": `text/plain` },
      })
    }
  } else if (method === `DELETE`) {
    ctx.injectedFaults.clear()
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": `application/json` },
    })
  } else {
    return new Response(`Method not allowed`, {
      status: 405,
      headers: { "content-type": `text/plain` },
    })
  }
}
