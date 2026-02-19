import type { ServerContext } from "./context"
import {
  STREAM_OFFSET_HEADER,
  STREAM_CLOSED_HEADER,
} from "./constants"

export function handleHead(
  ctx: ServerContext,
  path: string
): Response {
  const stream = ctx.store.get(path)
  if (!stream) {
    return new Response(null, {
      status: 404,
      headers: { "content-type": `text/plain` },
    })
  }

  const headers = new Headers({
    [STREAM_OFFSET_HEADER]: stream.currentOffset,
    "cache-control": `no-store`,
  })

  if (stream.contentType) {
    headers.set(`content-type`, stream.contentType)
  }

  if (stream.closed) {
    headers.set(STREAM_CLOSED_HEADER, `true`)
  }

  const closedSuffix = stream.closed ? `:c` : ``
  headers.set(
    `etag`,
    `"${btoa(path)}:-1:${stream.currentOffset}${closedSuffix}"`
  )

  return new Response(null, { status: 200, headers })
}
