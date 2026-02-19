import type { ServerContext } from "./context"

export function handleDelete(ctx: ServerContext, path: string): Response {
  if (!ctx.store.has(path)) {
    return new Response(`Stream not found`, {
      status: 404,
      headers: { "content-type": `text/plain` },
    })
  }

  ctx.store.delete(path)

  return new Response(null, { status: 204 })
}
