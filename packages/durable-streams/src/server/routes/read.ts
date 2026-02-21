import { generateResponseCursor } from "../../cursor"
import { formatSingleJsonMessage, formatInternalOffset } from "../../store"
import type { StreamMessage } from "../../types"
import type { ServerContext, InjectedFault } from "../lib/context"
import { encodeSSEData } from "../lib/sse"
import {
  getCompressionEncoding,
  compressData,
  COMPRESSION_THRESHOLD,
} from "../lib/compression"
import {
  STREAM_OFFSET_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_UP_TO_DATE_HEADER,
  STREAM_CLOSED_HEADER,
  STREAM_SSE_DATA_ENCODING_HEADER,
  SSE_OFFSET_FIELD,
  SSE_CURSOR_FIELD,
  SSE_UP_TO_DATE_FIELD,
  SSE_CLOSED_FIELD,
  OFFSET_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  CURSOR_QUERY_PARAM,
  setDurableStreamHeaders,
} from "../lib/constants"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Pre-encoded static SSE frame prefixes
const SSE_EVENT_DATA_PREFIX = encoder.encode(`event: data\n`)
const SSE_EVENT_CONTROL_PREFIX = encoder.encode(`event: control\n`)

/** Encode an SSE frame (event prefix + data payload) into a single Uint8Array */
function encodeSSEFrame(
  prefix: Uint8Array,
  payload: string
): Uint8Array {
  const encoded = encoder.encode(encodeSSEData(payload))
  const frame = new Uint8Array(prefix.length + encoded.length)
  frame.set(prefix)
  frame.set(encoded, prefix.length)
  return frame
}

/** Portable base64 encoding — prefers native Buffer (Node/Bun) with btoa fallback (Edge/Workers/Deno). */
function encodeBase64(data: Uint8Array): string {
  if (typeof Buffer !== `undefined`) {
    return Buffer.from(data).toString(`base64`)
  }
  let binary = ``
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  return btoa(binary)
}

/** Build and enqueue a control event. Returns true if the stream is closed (caller should break). */
function emitControlEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  opts: {
    offset: string
    closed: boolean
    cursor?: string
    upToDate?: boolean
  }
): boolean {
  const data: Record<string, string | boolean> = {
    [SSE_OFFSET_FIELD]: opts.offset,
  }

  if (opts.closed) {
    data[SSE_CLOSED_FIELD] = true
  } else {
    if (opts.cursor) data[SSE_CURSOR_FIELD] = opts.cursor
    if (opts.upToDate) data[SSE_UP_TO_DATE_FIELD] = true
  }

  controller.enqueue(encodeSSEFrame(SSE_EVENT_CONTROL_PREFIX, JSON.stringify(data)))
  return opts.closed
}

export function waitForStoreMessages(
  ctx: ServerContext,
  path: string,
  offset: string,
  timeoutMs: number
): Promise<{
  messages: Array<StreamMessage>
  timedOut: boolean
  streamClosed: boolean
}> {
  return new Promise((resolve) => {
    let settled = false

    const unsubscribe = ctx.store.subscribe(path, offset, (event) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      resolve({
        messages: event.messages,
        timedOut: false,
        streamClosed: event.type === `closed` || event.type === `deleted`,
      })
    })

    const timeoutHandle = setTimeout(() => {
      if (settled) return
      settled = true
      unsubscribe()
      // Fresh lookup after unsubscribe: the stream may have been closed or deleted
      // in the gap between the subscription expiring and this timeout firing.
      // If deleted, `s` is undefined and streamClosed defaults to false — correct
      // because the caller handles 404 on the next read attempt.
      const s = ctx.store.get(path)
      resolve({ messages: [], timedOut: true, streamClosed: s?.closed ?? false })
    }, timeoutMs)
  })
}

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

    ctx.activeLongPollRequests++
    const result = await waitForStoreMessages(
      ctx,
      path,
      effectiveOffset ?? streamOffset,
      ctx.config.longPollTimeout
    )
    ctx.activeLongPollRequests--

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
      responseData = await compressData(responseData, compressionEncoding)
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

function formatMessagePayload(
  data: Uint8Array,
  useBase64: boolean,
  isJsonStream: boolean | undefined
): string {
  if (useBase64) return encodeBase64(data)
  if (isJsonStream) return formatSingleJsonMessage(data)
  return decoder.decode(data)
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

      // INVARIANT: Must be called sequentially — mutates `currentOffset` via closure.
      // Safe because the SSE loop is await-based; no concurrent calls are possible.
      const emitMessages = (messages: Array<{ data: Uint8Array; offset: string }>) => {
        for (const message of messages) {
          const dataPayload = formatMessagePayload(message.data, useBase64, isJsonStream)
          controller.enqueue(encodeSSEFrame(SSE_EVENT_DATA_PREFIX, dataPayload))
          currentOffset = message.offset
        }
      }

      /** Check if stream is closed at tail and emit closed control if so. Returns true to break. */
      const checkClosed = (): boolean => {
        const s = ctx.store.get(path)
        if (!s?.closed) return false
        const off = formatInternalOffset(s.currentOffset)
        if (currentOffset !== off) return false
        return emitControlEvent(controller, { offset: currentOffset, closed: true })
      }

      try {
        // Initial catch-up read
        {
          const { messages } = ctx.store.read(path, currentOffset)
          emitMessages(messages)
          // If offset was "-1" (from-beginning) and stream was empty, advance
          // currentOffset to the stream's actual tail so control events report
          // the correct offset rather than the sentinel "-1" value.
          if (currentOffset === `-1`) {
            const s = ctx.store.get(path)
            if (s) currentOffset = formatInternalOffset(s.currentOffset)
          }
        }

        while (isConnected && !ctx.isShuttingDown) {
          // Emit control event with current state
          const currentStream = ctx.store.get(path)
          const currentStreamOff = formatInternalOffset(currentStream!.currentOffset)
          const streamIsClosed = (currentStream?.closed ?? false) && currentOffset === currentStreamOff
          const responseCursor = generateResponseCursor(cursor, ctx.config.cursorOptions)

          if (emitControlEvent(controller, {
            offset: currentOffset,
            closed: streamIsClosed,
            cursor: responseCursor,
            upToDate: true,
          })) break

          if (checkClosed()) break

          const result = await waitForStoreMessages(
            ctx,
            path,
            currentOffset,
            ctx.config.longPollTimeout
          )

          if (ctx.isShuttingDown || !isConnected) break

          // After wait: check closed (covers streamClosed + race)
          if (result.streamClosed || checkClosed()) break

          // Timeout keepalive
          if (result.timedOut) {
            if (checkClosed()) break
            const keepAliveCursor = generateResponseCursor(cursor, ctx.config.cursorOptions)
            emitControlEvent(controller, {
              offset: currentOffset,
              closed: false,
              cursor: keepAliveCursor,
              upToDate: true,
            })
            continue
          }

          // waitForMessages returned new messages — emit them directly
          // then read() to catch any additional messages that arrived after the long-poll resolved
          emitMessages(result.messages)
          const { messages: catchUp } = ctx.store.read(path, currentOffset)
          emitMessages(catchUp)
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
