import { Elysia } from "elysia"
import {
  handleDurableStreamRequest,
  type ServerContext,
} from "@ellie/durable-streams/server"

export function streamRoutes(ctx: ServerContext, enabled: boolean) {
  const handle = (request: Request, path: string) => {
    if (!enabled) return new Response(`Not found`, { status: 404 })
    return handleDurableStreamRequest(ctx, request, `/${path}`)
  }

  return new Elysia({ prefix: `/streams` })
    // Typed :id routes — used by Treaty for type-safe RPC.
    // Stream paths are URL-encoded into a single segment (e.g. chat%2Froom-1).
    .put(`/:id`, ({ request, params }) =>
      handle(request, decodeURIComponent(params.id))
    )
    .post(`/:id`, ({ request, params }) =>
      handle(request, decodeURIComponent(params.id))
    )
    .get(`/:id`, ({ request, params }) =>
      handle(request, decodeURIComponent(params.id))
    )
    .head(`/:id`, ({ request, params }) =>
      handle(request, decodeURIComponent(params.id))
    )
    .delete(`/:id`, ({ request, params }) =>
      handle(request, decodeURIComponent(params.id))
    )
    // Wildcard catch-all — matches multi-segment paths for raw HTTP clients
    // and backward compatibility (e.g. /streams/v1/stream/my-stream).
    .put(`/*`, ({ request, params }) => handle(request, params[`*`]))
    .post(`/*`, ({ request, params }) => handle(request, params[`*`]))
    .get(`/*`, ({ request, params }) => handle(request, params[`*`]))
    .head(`/*`, ({ request, params }) => handle(request, params[`*`]))
    .delete(`/*`, ({ request, params }) => handle(request, params[`*`]))
}
