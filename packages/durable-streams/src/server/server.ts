import { generateResponseCursor } from "../cursor"
import { formatSingleJsonMessage, formatInternalOffset } from "../store"
import {
  type ServerContext,
  type InjectedFault,
  consumeInjectedFault,
  setDurableStreamHeaders,
  encodeSSEData,
  getCompressionEncoding,
  compressData,
  COMPRESSION_THRESHOLD,
  STREAM_OFFSET_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_UP_TO_DATE_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_TTL_HEADER,
  STREAM_EXPIRES_AT_HEADER,
  STREAM_SSE_DATA_ENCODING_HEADER,
  STREAM_CLOSED_HEADER,
  PRODUCER_ID_HEADER,
  PRODUCER_EPOCH_HEADER,
  PRODUCER_SEQ_HEADER,
  PRODUCER_EXPECTED_SEQ_HEADER,
  PRODUCER_RECEIVED_SEQ_HEADER,
  SSE_OFFSET_FIELD,
  SSE_CURSOR_FIELD,
  SSE_UP_TO_DATE_FIELD,
  SSE_CLOSED_FIELD,
  OFFSET_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  CURSOR_QUERY_PARAM,
} from "./server-utils"

export {
  createServerContext,
  consumeInjectedFault,
  setDurableStreamHeaders,
  type ServerContext,
  type ServerConfig,
  type InjectedFault,
} from "./server-utils"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// ── CORS helper ──────────────────────────────────────────────────────

function applyCorsHeaders(response: Response): Response {
  const h: Record<string, string> = {}
  setDurableStreamHeaders(h)
  for (const [k, v] of Object.entries(h)) {
    response.headers.set(k, String(v))
  }
  return response
}

// ── Main dispatcher ──────────────────────────────────────────────────

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

// ── PUT – Create stream ──────────────────────────────────────────────

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
    [STREAM_OFFSET_HEADER]: formatInternalOffset(stream.currentOffset),
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

// ── POST – Append to stream ─────────────────────────────────────────

export async function handleAppend(
  ctx: ServerContext,
  request: Request,
  path: string
): Promise<Response> {
  const contentType = request.headers.get(`content-type`)
  const seq = request.headers.get(STREAM_SEQ_HEADER.toLowerCase()) ?? undefined

  const closedHeader = request.headers.get(STREAM_CLOSED_HEADER.toLowerCase())
  const closeStream = closedHeader === `true`

  const producerId =
    request.headers.get(PRODUCER_ID_HEADER.toLowerCase()) ?? undefined
  const producerEpochStr =
    request.headers.get(PRODUCER_EPOCH_HEADER.toLowerCase()) ?? undefined
  const producerSeqStr =
    request.headers.get(PRODUCER_SEQ_HEADER.toLowerCase()) ?? undefined

  // Validate producer headers - all three must be present together or none
  const hasProducerHeaders =
    producerId !== undefined ||
    producerEpochStr !== undefined ||
    producerSeqStr !== undefined
  const hasAllProducerHeaders =
    producerId !== undefined &&
    producerEpochStr !== undefined &&
    producerSeqStr !== undefined

  if (hasProducerHeaders && !hasAllProducerHeaders) {
    return new Response(
      `All producer headers (Producer-Id, Producer-Epoch, Producer-Seq) must be provided together`,
      { status: 400, headers: { "content-type": `text/plain` } }
    )
  }

  if (hasAllProducerHeaders && producerId === ``) {
    return new Response(`Invalid Producer-Id: must not be empty`, {
      status: 400,
      headers: { "content-type": `text/plain` },
    })
  }

  const STRICT_INTEGER_REGEX = /^\d+$/
  let producerEpoch: number | undefined
  let producerSeq: number | undefined
  if (hasAllProducerHeaders) {
    if (!STRICT_INTEGER_REGEX.test(producerEpochStr!)) {
      return new Response(
        `Invalid Producer-Epoch: must be a non-negative integer`,
        { status: 400, headers: { "content-type": `text/plain` } }
      )
    }
    producerEpoch = Number(producerEpochStr)
    if (!Number.isSafeInteger(producerEpoch)) {
      return new Response(
        `Invalid Producer-Epoch: must be a non-negative integer`,
        { status: 400, headers: { "content-type": `text/plain` } }
      )
    }

    if (!STRICT_INTEGER_REGEX.test(producerSeqStr!)) {
      return new Response(
        `Invalid Producer-Seq: must be a non-negative integer`,
        { status: 400, headers: { "content-type": `text/plain` } }
      )
    }
    producerSeq = Number(producerSeqStr)
    if (!Number.isSafeInteger(producerSeq)) {
      return new Response(
        `Invalid Producer-Seq: must be a non-negative integer`,
        { status: 400, headers: { "content-type": `text/plain` } }
      )
    }
  }

  const body = new Uint8Array(await request.arrayBuffer())

  // Handle close-only request (empty body with Stream-Closed: true)
  if (body.length === 0 && closeStream) {
    if (hasAllProducerHeaders) {
      const closeResult = await ctx.store.closeStreamWithProducer(path, {
        producerId: producerId!,
        producerEpoch: producerEpoch!,
        producerSeq: producerSeq!,
      })

      if (!closeResult) {
        return new Response(`Stream not found`, {
          status: 404,
          headers: { "content-type": `text/plain` },
        })
      }

      if (closeResult.producerResult?.status === `duplicate`) {
        return new Response(null, {
          status: 204,
          headers: {
            [STREAM_OFFSET_HEADER]: closeResult.finalOffset,
            [STREAM_CLOSED_HEADER]: `true`,
            [PRODUCER_EPOCH_HEADER]: producerEpoch!.toString(),
            [PRODUCER_SEQ_HEADER]:
              closeResult.producerResult.lastSeq.toString(),
          },
        })
      }

      if (closeResult.producerResult?.status === `stale_epoch`) {
        return new Response(`Stale producer epoch`, {
          status: 403,
          headers: {
            "content-type": `text/plain`,
            [PRODUCER_EPOCH_HEADER]:
              closeResult.producerResult.currentEpoch.toString(),
          },
        })
      }

      if (closeResult.producerResult?.status === `invalid_epoch_seq`) {
        return new Response(`New epoch must start with sequence 0`, {
          status: 400,
          headers: { "content-type": `text/plain` },
        })
      }

      if (closeResult.producerResult?.status === `sequence_gap`) {
        return new Response(`Producer sequence gap`, {
          status: 409,
          headers: {
            "content-type": `text/plain`,
            [PRODUCER_EXPECTED_SEQ_HEADER]:
              closeResult.producerResult.expectedSeq.toString(),
            [PRODUCER_RECEIVED_SEQ_HEADER]:
              closeResult.producerResult.receivedSeq.toString(),
          },
        })
      }

      if (closeResult.producerResult?.status === `stream_closed`) {
        const stream = ctx.store.get(path)
        return new Response(`Stream is closed`, {
          status: 409,
          headers: {
            "content-type": `text/plain`,
            [STREAM_CLOSED_HEADER]: `true`,
            [STREAM_OFFSET_HEADER]: stream ? formatInternalOffset(stream.currentOffset) : ``,
          },
        })
      }

      return new Response(null, {
        status: 204,
        headers: {
          [STREAM_OFFSET_HEADER]: closeResult.finalOffset,
          [STREAM_CLOSED_HEADER]: `true`,
          [PRODUCER_EPOCH_HEADER]: producerEpoch!.toString(),
          [PRODUCER_SEQ_HEADER]: producerSeq!.toString(),
        },
      })
    }

    // Close-only without producer headers
    const closeResult = ctx.store.closeStream(path)
    if (!closeResult) {
      return new Response(`Stream not found`, {
        status: 404,
        headers: { "content-type": `text/plain` },
      })
    }

    return new Response(null, {
      status: 204,
      headers: {
        [STREAM_OFFSET_HEADER]: closeResult.finalOffset,
        [STREAM_CLOSED_HEADER]: `true`,
      },
    })
  }

  // Empty body without Stream-Closed is an error
  if (body.length === 0) {
    return new Response(`Empty body`, {
      status: 400,
      headers: { "content-type": `text/plain` },
    })
  }

  // Content-Type is required for requests with body
  if (!contentType) {
    return new Response(`Content-Type header is required`, {
      status: 400,
      headers: { "content-type": `text/plain` },
    })
  }

  const appendOptions = {
    seq,
    contentType,
    producerId,
    producerEpoch,
    producerSeq,
    close: closeStream,
  }

  let result: Awaited<ReturnType<typeof ctx.store.appendWithProducer>>
  try {
    if (producerId !== undefined) {
      result = await ctx.store.appendWithProducer(path, body, appendOptions)
    } else {
      result = ctx.store.append(path, body, appendOptions)
    }
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes(`not found`)) {
        return new Response(`Stream not found`, {
          status: 404,
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
    throw err
  }

  const { message, producerResult, streamClosed } = result

  // Handle append to closed stream
  if (streamClosed && !message) {
    if (producerResult?.status === `duplicate`) {
      const stream = ctx.store.get(path)
      return new Response(null, {
        status: 204,
        headers: {
          [STREAM_OFFSET_HEADER]: stream ? formatInternalOffset(stream.currentOffset) : ``,
          [STREAM_CLOSED_HEADER]: `true`,
          [PRODUCER_EPOCH_HEADER]: producerEpoch!.toString(),
          [PRODUCER_SEQ_HEADER]: producerResult.lastSeq.toString(),
        },
      })
    }

    const closedStream = ctx.store.get(path)
    return new Response(`Stream is closed`, {
      status: 409,
      headers: {
        "content-type": `text/plain`,
        [STREAM_CLOSED_HEADER]: `true`,
        [STREAM_OFFSET_HEADER]: closedStream ? formatInternalOffset(closedStream.currentOffset) : ``,
      },
    })
  }

  if (!producerResult || producerResult.status === `accepted`) {
    const responseHeaders: Record<string, string> = {
      [STREAM_OFFSET_HEADER]: message!.offset,
    }
    if (producerEpoch !== undefined) {
      responseHeaders[PRODUCER_EPOCH_HEADER] = producerEpoch.toString()
    }
    if (producerSeq !== undefined) {
      responseHeaders[PRODUCER_SEQ_HEADER] = producerSeq.toString()
    }
    if (streamClosed) {
      responseHeaders[STREAM_CLOSED_HEADER] = `true`
    }
    const statusCode = producerId !== undefined ? 200 : 204
    return new Response(null, { status: statusCode, headers: responseHeaders })
  }

  // Handle producer validation failures
  switch (producerResult.status) {
    case `duplicate`: {
      const dupHeaders: Record<string, string> = {
        [PRODUCER_EPOCH_HEADER]: producerEpoch!.toString(),
        [PRODUCER_SEQ_HEADER]: producerResult.lastSeq.toString(),
      }
      if (streamClosed) {
        dupHeaders[STREAM_CLOSED_HEADER] = `true`
      }
      return new Response(null, { status: 204, headers: dupHeaders })
    }

    case `stale_epoch`:
      return new Response(`Stale producer epoch`, {
        status: 403,
        headers: {
          "content-type": `text/plain`,
          [PRODUCER_EPOCH_HEADER]:
            producerResult.currentEpoch.toString(),
        },
      })

    case `invalid_epoch_seq`:
      return new Response(`New epoch must start with sequence 0`, {
        status: 400,
        headers: { "content-type": `text/plain` },
      })

    case `sequence_gap`:
      return new Response(`Producer sequence gap`, {
        status: 409,
        headers: {
          "content-type": `text/plain`,
          [PRODUCER_EXPECTED_SEQ_HEADER]:
            producerResult.expectedSeq.toString(),
          [PRODUCER_RECEIVED_SEQ_HEADER]:
            producerResult.receivedSeq.toString(),
        },
      })
  }

  // Unreachable but TypeScript doesn't know the switch is exhaustive on the union
  return new Response(null, { status: 204 })
}

// ── GET – Read from stream ───────────────────────────────────────────

export async function handleRead(
  ctx: ServerContext,
  request: Request,
  path: string,
  url: URL,
  fault: InjectedFault | null
): Promise<Response> {
  const stream = ctx.store.get(path)
  if (!stream) {
    return new Response(`Stream not found`, {
      status: 404,
      headers: { "content-type": `text/plain` },
    })
  }

  const offset = url.searchParams.get(OFFSET_QUERY_PARAM) ?? undefined
  const live = url.searchParams.get(LIVE_QUERY_PARAM)
  const cursor = url.searchParams.get(CURSOR_QUERY_PARAM) ?? undefined

  // Validate offset
  if (offset !== undefined) {
    if (offset === ``) {
      return new Response(`Empty offset parameter`, {
        status: 400,
        headers: { "content-type": `text/plain` },
      })
    }

    const allOffsets = url.searchParams.getAll(OFFSET_QUERY_PARAM)
    if (allOffsets.length > 1) {
      return new Response(`Multiple offset parameters not allowed`, {
        status: 400,
        headers: { "content-type": `text/plain` },
      })
    }

    const validOffsetPattern = /^(-1|now|\d+_\d+)$/
    if (!validOffsetPattern.test(offset)) {
      return new Response(`Invalid offset format`, {
        status: 400,
        headers: { "content-type": `text/plain` },
      })
    }
  }

  // Require offset for live modes
  if ((live === `long-poll` || live === `sse`) && !offset) {
    return new Response(
      `${live === `sse` ? `SSE` : `Long-poll`} requires offset parameter`,
      { status: 400, headers: { "content-type": `text/plain` } }
    )
  }

  // Determine base64 encoding for SSE binary streams
  let useBase64 = false
  if (live === `sse`) {
    const ct = stream.contentType?.toLowerCase().split(`;`)[0]?.trim() ?? ``
    const isTextCompatible =
      ct.startsWith(`text/`) || ct === `application/json`
    useBase64 = !isTextCompatible
  }

  const streamOffset = formatInternalOffset(stream.currentOffset)

  // Handle SSE mode
  if (live === `sse`) {
    const sseOffset = offset === `now` ? streamOffset : offset!
    return handleSSE(ctx, path, stream, sseOffset, cursor, useBase64, fault)
  }

  // For offset=now, convert to tail offset
  const effectiveOffset = offset === `now` ? streamOffset : offset

  // Handle catch-up offset=now (not long-poll)
  if (offset === `now` && live !== `long-poll`) {
    const headers = new Headers({
      [STREAM_OFFSET_HEADER]: streamOffset,
      [STREAM_UP_TO_DATE_HEADER]: `true`,
      "cache-control": `no-store`,
    })

    if (stream.contentType) {
      headers.set(`content-type`, stream.contentType)
    }

    if (stream.closed) {
      headers.set(STREAM_CLOSED_HEADER, `true`)
    }

    const isJsonMode = stream.contentType?.includes(`application/json`)
    const responseBody = isJsonMode ? `[]` : ``

    return new Response(responseBody, { status: 200, headers })
  }

  // Read current messages
  let { messages, upToDate } = ctx.store.read(path, effectiveOffset)

  // Long-poll wait logic
  const clientIsCaughtUp =
    (effectiveOffset && effectiveOffset === streamOffset) ||
    offset === `now`
  if (live === `long-poll` && clientIsCaughtUp && messages.length === 0) {
    if (stream.closed) {
      return new Response(null, {
        status: 204,
        headers: {
          [STREAM_OFFSET_HEADER]: streamOffset,
          [STREAM_UP_TO_DATE_HEADER]: `true`,
          [STREAM_CLOSED_HEADER]: `true`,
        },
      })
    }

    const result = await ctx.store.waitForMessages(
      path,
      effectiveOffset ?? streamOffset,
      ctx.config.longPollTimeout
    )

    if (result.streamClosed) {
      const responseCursor = generateResponseCursor(
        cursor,
        ctx.config.cursorOptions
      )
      return new Response(null, {
        status: 204,
        headers: {
          [STREAM_OFFSET_HEADER]: effectiveOffset ?? streamOffset,
          [STREAM_UP_TO_DATE_HEADER]: `true`,
          [STREAM_CURSOR_HEADER]: responseCursor,
          [STREAM_CLOSED_HEADER]: `true`,
        },
      })
    }

    if (result.timedOut) {
      const responseCursor = generateResponseCursor(
        cursor,
        ctx.config.cursorOptions
      )
      const currentStream = ctx.store.get(path)
      const timeoutHeaders: Record<string, string> = {
        [STREAM_OFFSET_HEADER]: effectiveOffset ?? streamOffset,
        [STREAM_UP_TO_DATE_HEADER]: `true`,
        [STREAM_CURSOR_HEADER]: responseCursor,
      }
      if (currentStream?.closed) {
        timeoutHeaders[STREAM_CLOSED_HEADER] = `true`
      }
      return new Response(null, { status: 204, headers: timeoutHeaders })
    }

    messages = result.messages
    upToDate = true
  }

  // Build response
  const headers = new Headers()

  if (stream.contentType) {
    headers.set(`content-type`, stream.contentType)
  }

  const lastMessage = messages[messages.length - 1]
  const responseOffset = lastMessage?.offset ?? streamOffset
  headers.set(STREAM_OFFSET_HEADER, responseOffset)

  if (live === `long-poll`) {
    headers.set(
      STREAM_CURSOR_HEADER,
      generateResponseCursor(cursor, ctx.config.cursorOptions)
    )
  }

  if (upToDate) {
    headers.set(STREAM_UP_TO_DATE_HEADER, `true`)
  }

  const currentStream = ctx.store.get(path)
  const currentStreamOffset = currentStream ? formatInternalOffset(currentStream.currentOffset) : undefined
  const clientAtTail = responseOffset === currentStreamOffset
  if (currentStream?.closed && clientAtTail && upToDate) {
    headers.set(STREAM_CLOSED_HEADER, `true`)
  }

  // ETag
  const startOffset = offset ?? `-1`
  const closedSuffix =
    currentStream?.closed && clientAtTail && upToDate ? `:c` : ``
  const etag = `"${btoa(path)}:${startOffset}:${responseOffset}${closedSuffix}"`
  headers.set(`etag`, etag)

  // Conditional GET
  const ifNoneMatch = request.headers.get(`if-none-match`)
  if (ifNoneMatch && ifNoneMatch === etag) {
    const notModifiedHeaders: Record<string, string> = { etag }
    if (ctx.config.compression) {
      notModifiedHeaders[`vary`] = `accept-encoding`
    }
    return new Response(null, { status: 304, headers: new Headers(notModifiedHeaders) })
  }

  // Format response data
  let responseData = ctx.store.formatResponse(stream?.contentType, messages)

  // Compression
  if (
    ctx.config.compression &&
    responseData.length >= COMPRESSION_THRESHOLD
  ) {
    const acceptEncoding = request.headers.get(`accept-encoding`)
    const compressionEncoding = getCompressionEncoding(acceptEncoding ?? undefined)
    if (compressionEncoding) {
      responseData = compressData(responseData, compressionEncoding)
      headers.set(`content-encoding`, compressionEncoding)
      headers.set(`vary`, `accept-encoding`)
    }
  }

  // Fault body modifications
  if (fault) {
    responseData = applyFaultBodyModification(fault, responseData)
  }

  return new Response(responseData as unknown as BodyInit, { status: 200, headers })
}

function applyFaultBodyModification(
  fault: InjectedFault,
  body: Uint8Array
): Uint8Array {
  let modified = body

  if (
    fault.truncateBodyBytes !== undefined &&
    modified.length > fault.truncateBodyBytes
  ) {
    modified = modified.slice(0, fault.truncateBodyBytes)
  }

  if (fault.corruptBody && modified.length > 0) {
    modified = new Uint8Array(modified)
    modified[0] = 0x58
    if (modified.length > 1) {
      modified[1] = 0x59
    }
    const numCorrupt = Math.max(1, Math.floor(modified.length * 0.1))
    for (let i = 0; i < numCorrupt; i++) {
      const pos = Math.floor(Math.random() * modified.length)
      modified[pos] = 0x5a
    }
  }

  return modified
}

function handleSSE(
  ctx: ServerContext,
  path: string,
  stream: ReturnType<typeof ctx.store.get>,
  initialOffset: string,
  cursor: string | undefined,
  useBase64: boolean,
  fault: InjectedFault | null
): Response {
  const isJsonStream = stream?.contentType?.includes(`application/json`)

  let isConnected = true
  let controllerRef: ReadableStreamDefaultController<Uint8Array>

  const readable = new ReadableStream({
    async start(controller) {
      controllerRef = controller
      ctx.activeSSEResponses.add(controller)

      // Inject SSE fault event if configured
      if (fault?.injectSseEvent) {
        const injected =
          `event: ${fault.injectSseEvent.eventType}\n` +
          `data: ${fault.injectSseEvent.data}\n\n`
        controller.enqueue(encoder.encode(injected))
      }

      let currentOffset = initialOffset

      const cleanup = () => {
        isConnected = false
        ctx.activeSSEResponses.delete(controller)
      }

      try {
        while (isConnected && !ctx.isShuttingDown) {
          const { messages, upToDate } = ctx.store.read(path, currentOffset)

          for (const message of messages) {
            let dataPayload: string
            if (useBase64) {
              dataPayload = Buffer.from(message.data).toString(`base64`)
            } else if (isJsonStream) {
              dataPayload = formatSingleJsonMessage(message.data)
            } else {
              dataPayload = decoder.decode(message.data)
            }

            controller.enqueue(
              encoder.encode(
                `event: data\n` + encodeSSEData(dataPayload)
              )
            )

            currentOffset = message.offset
          }

          const currentStream = ctx.store.get(path)
          const currentStreamOff = formatInternalOffset(currentStream!.currentOffset)
          const controlOffset =
            messages[messages.length - 1]?.offset ??
            currentStreamOff

          const streamIsClosed = currentStream?.closed ?? false
          const clientAtTail = controlOffset === currentStreamOff

          const responseCursor = generateResponseCursor(
            cursor,
            ctx.config.cursorOptions
          )
          const controlData: Record<string, string | boolean> = {
            [SSE_OFFSET_FIELD]: controlOffset,
          }

          if (streamIsClosed && clientAtTail) {
            controlData[SSE_CLOSED_FIELD] = true
          } else {
            controlData[SSE_CURSOR_FIELD] = responseCursor
            if (upToDate) {
              controlData[SSE_UP_TO_DATE_FIELD] = true
            }
          }

          controller.enqueue(
            encoder.encode(
              `event: control\n` + encodeSSEData(JSON.stringify(controlData))
            )
          )

          if (streamIsClosed && clientAtTail) break

          currentOffset = controlOffset

          if (upToDate) {
            if (currentStream?.closed) {
              const finalControlData: Record<string, string | boolean> = {
                [SSE_OFFSET_FIELD]: currentOffset,
                [SSE_CLOSED_FIELD]: true,
              }
              controller.enqueue(
                encoder.encode(
                  `event: control\n` +
                    encodeSSEData(JSON.stringify(finalControlData))
                )
              )
              break
            }

            const result = await ctx.store.waitForMessages(
              path,
              currentOffset,
              ctx.config.longPollTimeout
            )

            if (ctx.isShuttingDown || !isConnected) break

            if (result.streamClosed) {
              const finalControlData: Record<string, string | boolean> = {
                [SSE_OFFSET_FIELD]: currentOffset,
                [SSE_CLOSED_FIELD]: true,
              }
              controller.enqueue(
                encoder.encode(
                  `event: control\n` +
                    encodeSSEData(JSON.stringify(finalControlData))
                )
              )
              break
            }

            if (result.timedOut) {
              const keepAliveCursor = generateResponseCursor(
                cursor,
                ctx.config.cursorOptions
              )

              const streamAfterWait = ctx.store.get(path)
              if (streamAfterWait?.closed) {
                const closedControlData: Record<string, string | boolean> = {
                  [SSE_OFFSET_FIELD]: currentOffset,
                  [SSE_CLOSED_FIELD]: true,
                }
                controller.enqueue(
                  encoder.encode(
                    `event: control\n` +
                      encodeSSEData(JSON.stringify(closedControlData))
                  )
                )
                break
              }

              const keepAliveData: Record<string, string | boolean> = {
                [SSE_OFFSET_FIELD]: currentOffset,
                [SSE_CURSOR_FIELD]: keepAliveCursor,
                [SSE_UP_TO_DATE_FIELD]: true,
              }
              controller.enqueue(
                encoder.encode(
                  `event: control\n` +
                    encodeSSEData(JSON.stringify(keepAliveData))
                )
              )
            }
          }
        }
      } catch {
        // Client disconnected or error
      } finally {
        cleanup()
        try {
          controller.close()
        } catch {
          // Already closed
        }
      }
    },
    cancel() {
      isConnected = false
      if (controllerRef) {
        ctx.activeSSEResponses.delete(controllerRef)
      }
    },
  })

  const sseHeaders: Record<string, string> = {
    "content-type": `text/event-stream`,
    "cache-control": `no-cache`,
    connection: `keep-alive`,
  }
  setDurableStreamHeaders(sseHeaders)

  if (useBase64) {
    sseHeaders[STREAM_SSE_DATA_ENCODING_HEADER] = `base64`
  }

  return new Response(readable, { status: 200, headers: sseHeaders })
}

// ── HEAD – Stream metadata ───────────────────────────────────────────

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

// ── DELETE – Remove stream ───────────────────────────────────────────

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

// ── Test control – Fault injection ───────────────────────────────────

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
