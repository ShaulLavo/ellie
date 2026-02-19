import type { ServerContext } from "./context"
import {
  STREAM_OFFSET_HEADER,
  STREAM_TTL_HEADER,
  STREAM_EXPIRES_AT_HEADER,
  STREAM_CLOSED_HEADER,
} from "./constants"

export async function handleCreate(
  ctx: ServerContext,
  request: Request,
  path: string,
  url: URL
): Promise<Response> {
  let contentType = request.headers.get(`content-type`)
  if (
    !contentType ||
    contentType.trim() === `` ||
    !/^[\w-]+\/[\w-]+/.test(contentType)
  ) {
    contentType = `application/octet-stream`
  }

  const ttlHeader = request.headers.get(STREAM_TTL_HEADER.toLowerCase())
  const expiresAtHeader = request.headers.get(
    STREAM_EXPIRES_AT_HEADER.toLowerCase()
  )
  const closedHeader = request.headers.get(STREAM_CLOSED_HEADER.toLowerCase())
  const createClosed = closedHeader === `true`

  if (ttlHeader && expiresAtHeader) {
    return new Response(`Cannot specify both Stream-TTL and Stream-Expires-At`, {
      status: 400,
      headers: { "content-type": `text/plain` },
    })
  }

  let ttlSeconds: number | undefined
  if (ttlHeader) {
    const ttlPattern = /^(0|[1-9]\d*)$/
    if (!ttlPattern.test(ttlHeader)) {
      return new Response(`Invalid Stream-TTL value`, {
        status: 400,
        headers: { "content-type": `text/plain` },
      })
    }
    ttlSeconds = parseInt(ttlHeader, 10)
    if (isNaN(ttlSeconds) || ttlSeconds < 0) {
      return new Response(`Invalid Stream-TTL value`, {
        status: 400,
        headers: { "content-type": `text/plain` },
      })
    }
  }

  if (expiresAtHeader) {
    const timestamp = new Date(expiresAtHeader)
    if (isNaN(timestamp.getTime())) {
      return new Response(`Invalid Stream-Expires-At timestamp`, {
        status: 400,
        headers: { "content-type": `text/plain` },
      })
    }
  }

  const body = new Uint8Array(await request.arrayBuffer())
  const isNew = !ctx.store.has(path)

  try {
    ctx.store.create(path, {
      contentType,
      ttlSeconds,
      expiresAt: expiresAtHeader ?? undefined,
      initialData: body.length > 0 ? body : undefined,
      closed: createClosed,
    })
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes(`already exists with different configuration`)
    ) {
      return new Response(
        `Stream already exists with different configuration`,
        { status: 409, headers: { "content-type": `text/plain` } }
      )
    }
    throw err
  }

  const stream = ctx.store.get(path)!

  const headers = new Headers({
    "content-type": contentType,
    [STREAM_OFFSET_HEADER]: stream.currentOffset,
  })

  if (isNew) {
    headers.set(`location`, `${url.origin}${path}`)
  }

  if (stream.closed) {
    headers.set(STREAM_CLOSED_HEADER, `true`)
  }

  return new Response(null, {
    status: isNew ? 201 : 200,
    headers,
  })
}
