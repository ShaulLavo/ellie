import { formatInternalOffset } from "../../store"
import type { ServerContext } from "../lib/context"
import {
  STREAM_OFFSET_HEADER,
  STREAM_CLOSED_HEADER,
} from "../lib/constants"

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

  const streamOffset = formatInternalOffset(stream.currentOffset)

  const headers = new Headers({
    [STREAM_OFFSET_HEADER]: streamOffset,
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
    `"${btoa(path)}:-1:${streamOffset}${closedSuffix}"`
  )

  return new Response(null, { status: 200, headers })
}
