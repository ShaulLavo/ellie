import { Elysia } from "elysia"
import {
  handleDurableStreamRequest,
  type ServerContext,
} from "@ellie/durable-streams/server"

export function streamRoutes(ctx: ServerContext) {
  const handle = (request: Request, path: string) => {
    return handleDurableStreamRequest(ctx, request, `/${path}`)
  }

  return new Elysia({ prefix: `/streams` })
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
}
