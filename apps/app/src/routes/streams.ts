import { Elysia } from "elysia"
import {
  handleDurableStreamRequest,
  type ServerContext,
} from "@ellie/durable-streams/server"

export function streamRoutes(ctx: ServerContext, enabled: boolean) {
  const handle = (request: Request, wildcard: string) => {
    if (!enabled) return new Response(`Not found`, { status: 404 })
    return handleDurableStreamRequest(ctx, request, `/${wildcard}`)
  }

  return new Elysia({ prefix: `/streams` })
    .put(`/*`, ({ request, params }) => handle(request, params[`*`]))
    .post(`/*`, ({ request, params }) => handle(request, params[`*`]))
    .get(`/*`, ({ request, params }) => handle(request, params[`*`]))
    .head(`/*`, ({ request, params }) => handle(request, params[`*`]))
    .delete(`/*`, ({ request, params }) => handle(request, params[`*`]))
}
