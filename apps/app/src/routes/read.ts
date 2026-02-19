import { generateResponseCursor, formatSingleJsonMessage } from "@ellie/durable-streams"
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
} from "../lib/constants"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

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

  // Handle SSE mode
  if (live === `sse`) {
    const sseOffset = offset === `now` ? stream.currentOffset : offset!
    return handleSSE(ctx, path, stream, sseOffset, cursor, useBase64, fault)
  }

  // For offset=now, convert to tail offset
  const effectiveOffset = offset === `now` ? stream.currentOffset : offset

  // Handle catch-up offset=now (not long-poll)
  if (offset === `now` && live !== `long-poll`) {
    const headers = new Headers({
      [STREAM_OFFSET_HEADER]: stream.currentOffset,
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
    (effectiveOffset && effectiveOffset === stream.currentOffset) ||
    offset === `now`
  if (live === `long-poll` && clientIsCaughtUp && messages.length === 0) {
    if (stream.closed) {
      return new Response(null, {
        status: 204,
        headers: {
          [STREAM_OFFSET_HEADER]: stream.currentOffset,
          [STREAM_UP_TO_DATE_HEADER]: `true`,
          [STREAM_CLOSED_HEADER]: `true`,
        },
      })
    }

    const result = await ctx.store.waitForMessages(
      path,
      effectiveOffset ?? stream.currentOffset,
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
          [STREAM_OFFSET_HEADER]: effectiveOffset ?? stream.currentOffset,
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
        [STREAM_OFFSET_HEADER]: effectiveOffset ?? stream.currentOffset,
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
  const responseOffset = lastMessage?.offset ?? stream.currentOffset
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
  const clientAtTail = responseOffset === currentStream?.currentOffset
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
    return new Response(null, { status: 304, headers: new Headers({ etag }) })
  }

  // Format response data
  let responseData = ctx.store.formatResponse(path, messages)

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
          const controlOffset =
            messages[messages.length - 1]?.offset ??
            currentStream!.currentOffset

          const streamIsClosed = currentStream?.closed ?? false
          const clientAtTail = controlOffset === currentStream!.currentOffset

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
      ctx.activeSSEResponses.delete(controllerRef)
    },
  })

  const sseHeaders: Record<string, string> = {
    "content-type": `text/event-stream`,
    "cache-control": `no-cache`,
    connection: `keep-alive`,
    "access-control-allow-origin": `*`,
    "x-content-type-options": `nosniff`,
    "cross-origin-resource-policy": `cross-origin`,
  }

  if (useBase64) {
    sseHeaders[STREAM_SSE_DATA_ENCODING_HEADER] = `base64`
  }

  return new Response(readable, { status: 200, headers: sseHeaders })
}
