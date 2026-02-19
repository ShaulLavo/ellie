#!/usr/bin/env node
/**
 * Client conformance test adapter for @ellie/streams-client.
 *
 * This adapter implements the stdin/stdout protocol expected by
 * @durable-streams/client-conformance-tests, using our forked client.
 */

import { createInterface } from "node:readline"
import {
  DurableStream,
  DurableStreamError,
  FetchError,
  IdempotentProducer,
  StreamClosedError,
  stream,
} from "@ellie/streams-client"
import {
  ErrorCodes,
  decodeBase64,
  parseCommand,
  serializeResult,
} from "@durable-streams/client-conformance-tests"
import type {
  BenchmarkCommand,
  BenchmarkOperation,
  ErrorCode,
  ReadChunk,
  TestCommand,
  TestResult,
} from "@durable-streams/client-conformance-tests"

const CLIENT_VERSION = `0.1.0`

let serverUrl = ``

// Track content-type per stream path for append operations
const streamContentTypes = new Map<string, string>()

// Track IdempotentProducer instances to maintain state across operations
// Key: "path|producerId|epoch"
const producerCache = new Map<string, IdempotentProducer>()

function getProducerCacheKey(
  path: string,
  producerId: string,
  epoch: number
): string {
  return `${path}|${producerId}|${epoch}`
}

function getOrCreateProducer(
  path: string,
  producerId: string,
  epoch: number,
  autoClaim: boolean = false
): IdempotentProducer {
  const key = getProducerCacheKey(path, producerId, epoch)
  let producer = producerCache.get(key)
  if (!producer) {
    const contentType =
      streamContentTypes.get(path) ?? `application/octet-stream`
    const ds = new DurableStream({
      url: `${serverUrl}${path}`,
      contentType,
    })
    producer = new IdempotentProducer(ds, producerId, {
      epoch,
      autoClaim,
      maxInFlight: 1,
      lingerMs: 0, // Send immediately for testing
    })
    producerCache.set(key, producer)
  }
  return producer
}

function removeProducerFromCache(
  path: string,
  producerId: string,
  epoch: number
): void {
  const key = getProducerCacheKey(path, producerId, epoch)
  producerCache.delete(key)
}

// Dynamic headers/params state
interface DynamicValue {
  type: `counter` | `timestamp` | `token`
  counter: number
  tokenValue?: string
}

const dynamicHeaders = new Map<string, DynamicValue>()
const dynamicParams = new Map<string, DynamicValue>()

/** Resolve dynamic headers, returning both the header function map and tracked values */
function resolveDynamicHeaders(): {
  headers: Record<string, () => string>
  values: Record<string, string>
} {
  const headers: Record<string, () => string> = {}
  const values: Record<string, string> = {}

  for (const [name, config] of dynamicHeaders.entries()) {
    let value: string
    switch (config.type) {
      case `counter`:
        config.counter++
        value = config.counter.toString()
        break
      case `timestamp`:
        value = Date.now().toString()
        break
      case `token`:
        value = config.tokenValue ?? ``
        break
    }
    values[name] = value

    const capturedValue = value
    headers[name] = () => capturedValue
  }

  return { headers, values }
}

/** Resolve dynamic params */
function resolveDynamicParams(): {
  params: Record<string, () => string>
  values: Record<string, string>
} {
  const params: Record<string, () => string> = {}
  const values: Record<string, string> = {}

  for (const [name, config] of dynamicParams.entries()) {
    let value: string
    switch (config.type) {
      case `counter`:
        config.counter++
        value = config.counter.toString()
        break
      case `timestamp`:
        value = Date.now().toString()
        break
      default:
        value = ``
    }
    values[name] = value

    const capturedValue = value
    params[name] = () => capturedValue
  }

  return { params, values }
}

async function handleCommand(command: TestCommand): Promise<TestResult> {
  switch (command.type) {
    case `init`: {
      serverUrl = command.serverUrl
      // Clear all caches on init
      streamContentTypes.clear()
      dynamicHeaders.clear()
      dynamicParams.clear()
      producerCache.clear()
      return {
        type: `init`,
        success: true,
        clientName: `@ellie/streams-client`,
        clientVersion: CLIENT_VERSION,
        features: {
          batching: true,
          sse: true,
          longPoll: true,
          auto: true,
          streaming: true,
          dynamicHeaders: true,
          strictZeroValidation: true,
        },
      }
    }

    case `create`: {
      try {
        const url = `${serverUrl}${command.path}`
        const contentType = command.contentType ?? `application/octet-stream`

        // Check if stream already exists by trying to connect first
        let alreadyExists = false
        try {
          await DurableStream.head({ url })
          alreadyExists = true
        } catch {
          // Stream doesn't exist, which is expected for new creates
        }

        const ds = await DurableStream.create({
          url,
          contentType,
          ttlSeconds: command.ttlSeconds,
          expiresAt: command.expiresAt,
          headers: command.headers,
          closed: command.closed,
          body: command.data,
        })

        // Cache the content-type
        streamContentTypes.set(command.path, contentType)

        const head = await ds.head()

        return {
          type: `create`,
          success: true,
          status: alreadyExists ? 200 : 201,
          offset: head.offset,
        }
      } catch (err) {
        return errorResult(`create`, err)
      }
    }

    case `connect`: {
      try {
        const url = `${serverUrl}${command.path}`
        const ds = await DurableStream.connect({
          url,
          headers: command.headers,
        })

        const head = await ds.head()

        // Cache the content-type for this stream
        if (head.contentType) {
          streamContentTypes.set(command.path, head.contentType)
        }

        return {
          type: `connect`,
          success: true,
          status: 200,
          offset: head.offset,
        }
      } catch (err) {
        return errorResult(`connect`, err)
      }
    }

    case `append`: {
      try {
        const url = `${serverUrl}${command.path}`

        // Get content-type from cache or use default
        const contentType =
          streamContentTypes.get(command.path) ?? `application/octet-stream`

        // Resolve dynamic headers/params
        const { headers: dynamicHdrs, values: headersSent } =
          resolveDynamicHeaders()
        const { values: paramsSent } = resolveDynamicParams()

        // Merge command headers with dynamic headers (command takes precedence)
        const mergedHeaders: Record<string, string | (() => string)> = {
          ...dynamicHdrs,
          ...command.headers,
        }

        const ds = new DurableStream({
          url,
          headers: mergedHeaders,
          contentType,
        })

        let body: Uint8Array | string
        if (command.binary) {
          body = decodeBase64(command.data)
        } else {
          body = command.data
        }

        await ds.append(body, { seq: command.seq?.toString() })
        const head = await ds.head()

        return {
          type: `append`,
          success: true,
          status: 200,
          offset: head.offset,
          headersSent:
            Object.keys(headersSent).length > 0 ? headersSent : undefined,
          paramsSent:
            Object.keys(paramsSent).length > 0 ? paramsSent : undefined,
        }
      } catch (err) {
        return errorResult(`append`, err)
      }
    }

    case `read`: {
      try {
        const url = `${serverUrl}${command.path}`

        // Resolve dynamic headers/params
        const { headers: dynamicHdrs, values: headersSent } =
          resolveDynamicHeaders()
        const { values: paramsSent } = resolveDynamicParams()

        // Merge command headers with dynamic headers (command takes precedence)
        const mergedHeaders: Record<string, string | (() => string)> = {
          ...dynamicHdrs,
          ...command.headers,
        }

        // Determine live mode
        let live: true | `long-poll` | `sse` | false
        if (command.live === `long-poll`) {
          live = `long-poll`
        } else if (command.live === `sse`) {
          live = `sse`
        } else if (command.live === true) {
          live = true
        } else {
          live = false
        }

        // Create abort controller for timeout handling
        const abortController = new AbortController()
        const timeoutMs = command.timeoutMs ?? 5000

        // Set up timeout BEFORE calling stream()
        const timeoutId = setTimeout(() => {
          abortController.abort()
        }, timeoutMs)

        let response: Awaited<ReturnType<typeof stream>>
        try {
          response = await stream({
            url,
            offset: command.offset,
            live,
            headers: mergedHeaders,
            signal: abortController.signal,
          })
        } catch (err) {
          clearTimeout(timeoutId)
          if (abortController.signal.aborted) {
            return {
              type: `read`,
              success: true,
              status: 200,
              chunks: [],
              offset: command.offset ?? `-1`,
              upToDate: true,
              headersSent:
                Object.keys(headersSent).length > 0 ? headersSent : undefined,
              paramsSent:
                Object.keys(paramsSent).length > 0 ? paramsSent : undefined,
            }
          }
          throw err
        }

        clearTimeout(timeoutId)

        const chunks: Array<ReadChunk> = []
        let finalOffset = command.offset ?? response.offset
        let upToDate = response.upToDate
        let streamClosed = response.streamClosed

        const maxChunks = command.maxChunks ?? 100

        // Determine if we should use JSON parsing based on content type
        const contentType = streamContentTypes.get(command.path)
        const isJson = contentType?.includes(`application/json`) ?? false

        if (!live) {
          if (isJson) {
            const items = await response.json()
            if (items.length > 0) {
              chunks.push({
                data: JSON.stringify(items),
                offset: response.offset,
              })
            }
          } else {
            const data = await response.body()
            if (data.length > 0) {
              chunks.push({
                data: new TextDecoder().decode(data),
                offset: response.offset,
              })
            }
          }
          finalOffset = response.offset
          upToDate = response.upToDate
          streamClosed = response.streamClosed
        } else {
          const decoder = new TextDecoder()
          const startTime = Date.now()
          let chunkCount = 0
          let done = false

          await new Promise<void>((resolve, reject) => {
            const subscriptionTimeoutId = setTimeout(() => {
              done = true
              abortController.abort()
              upToDate = response.upToDate || true
              finalOffset = response.offset
              resolve()
            }, timeoutMs)

            const unsubscribe = response.subscribeBytes(async (chunk) => {
              if (done || chunkCount >= maxChunks) {
                return
              }

              if (Date.now() - startTime > timeoutMs) {
                done = true
                resolve()
                return
              }

              const hasData = chunk.data.length > 0
              if (hasData) {
                chunks.push({
                  data: decoder.decode(chunk.data),
                  offset: chunk.offset,
                })
                chunkCount++
              }

              finalOffset = chunk.offset
              upToDate = chunk.upToDate
              streamClosed = chunk.streamClosed

              if (command.waitForUpToDate && chunk.upToDate) {
                done = true
                clearTimeout(subscriptionTimeoutId)
                resolve()
                return
              }

              if (chunkCount >= maxChunks) {
                done = true
                clearTimeout(subscriptionTimeoutId)
                resolve()
              }

              await Promise.resolve()
            })

            response.closed
              .then(() => {
                if (!done) {
                  done = true
                  clearTimeout(subscriptionTimeoutId)
                  upToDate = response.upToDate
                  finalOffset = response.offset
                  streamClosed = response.streamClosed
                  resolve()
                }
              })
              .catch((err) => {
                if (!done) {
                  done = true
                  clearTimeout(subscriptionTimeoutId)
                  reject(err)
                }
              })

            void unsubscribe
          })
        }

        response.cancel()

        return {
          type: `read`,
          success: true,
          status: response.status,
          chunks,
          offset: finalOffset,
          upToDate,
          streamClosed,
          headersSent:
            Object.keys(headersSent).length > 0 ? headersSent : undefined,
          paramsSent:
            Object.keys(paramsSent).length > 0 ? paramsSent : undefined,
        }
      } catch (err) {
        return errorResult(`read`, err)
      }
    }

    case `head`: {
      try {
        const url = `${serverUrl}${command.path}`
        const result = await DurableStream.head({
          url,
          headers: command.headers,
        })

        if (result.contentType) {
          streamContentTypes.set(command.path, result.contentType)
        }

        return {
          type: `head`,
          success: true,
          status: 200,
          offset: result.offset,
          contentType: result.contentType,
          streamClosed: result.streamClosed,
        }
      } catch (err) {
        return errorResult(`head`, err)
      }
    }

    case `delete`: {
      try {
        const url = `${serverUrl}${command.path}`
        await DurableStream.delete({
          url,
          headers: command.headers,
        })

        streamContentTypes.delete(command.path)

        return {
          type: `delete`,
          success: true,
          status: 200,
        }
      } catch (err) {
        return errorResult(`delete`, err)
      }
    }

    case `close`: {
      try {
        const url = `${serverUrl}${command.path}`

        const contentType =
          streamContentTypes.get(command.path) ?? `application/octet-stream`

        const ds = new DurableStream({
          url,
          contentType: command.contentType ?? contentType,
        })

        const closeResult = await ds.close({
          body: command.data,
          contentType: command.contentType,
        })

        return {
          type: `close`,
          success: true,
          finalOffset: closeResult.finalOffset,
        }
      } catch (err) {
        return errorResult(`close`, err)
      }
    }

    case `shutdown`: {
      return {
        type: `shutdown`,
        success: true,
      }
    }

    case `benchmark`: {
      return handleBenchmark(command)
    }

    case `set-dynamic-header`: {
      dynamicHeaders.set(command.name, {
        type: command.valueType,
        counter: 0,
        tokenValue: command.initialValue,
      })
      return {
        type: `set-dynamic-header`,
        success: true,
      }
    }

    case `set-dynamic-param`: {
      dynamicParams.set(command.name, {
        type: command.valueType,
        counter: 0,
      })
      return {
        type: `set-dynamic-param`,
        success: true,
      }
    }

    case `clear-dynamic`: {
      dynamicHeaders.clear()
      dynamicParams.clear()
      return {
        type: `clear-dynamic`,
        success: true,
      }
    }

    case `idempotent-append`: {
      try {
        const producer = getOrCreateProducer(
          command.path,
          command.producerId,
          command.epoch,
          command.autoClaim
        )

        producer.append(command.data)
        await producer.flush()

        return {
          type: `idempotent-append`,
          success: true,
          status: 200,
        }
      } catch (err) {
        return errorResult(`idempotent-append`, err)
      }
    }

    case `idempotent-append-batch`: {
      try {
        const url = `${serverUrl}${command.path}`

        const contentType =
          streamContentTypes.get(command.path) ?? `application/octet-stream`

        const ds = new DurableStream({
          url,
          contentType,
        })

        const maxInFlight = command.maxInFlight ?? 1

        const testingConcurrency = maxInFlight > 1
        const producer = new IdempotentProducer(ds, command.producerId, {
          epoch: command.epoch,
          autoClaim: command.autoClaim,
          maxInFlight,
          lingerMs: testingConcurrency ? 0 : 1000,
          maxBatchBytes: testingConcurrency ? 1 : 1024 * 1024,
        })

        try {
          for (const item of command.items) {
            producer.append(item)
          }

          await producer.flush()
          await producer.detach()

          return {
            type: `idempotent-append-batch`,
            success: true,
            status: 200,
          }
        } catch (err) {
          await producer.detach()
          throw err
        }
      } catch (err) {
        return errorResult(`idempotent-append-batch`, err)
      }
    }

    case `idempotent-close`: {
      try {
        const producer = getOrCreateProducer(
          command.path,
          command.producerId,
          command.epoch,
          command.autoClaim
        )

        const result = await producer.close(command.data)

        return {
          type: `idempotent-close`,
          success: true,
          status: 200,
          finalOffset: result.finalOffset,
        }
      } catch (err) {
        return errorResult(`idempotent-close`, err)
      }
    }

    case `idempotent-detach`: {
      try {
        const producer = getOrCreateProducer(
          command.path,
          command.producerId,
          command.epoch
        )

        await producer.detach()

        removeProducerFromCache(command.path, command.producerId, command.epoch)

        return {
          type: `idempotent-detach`,
          success: true,
          status: 200,
        }
      } catch (err) {
        return errorResult(`idempotent-detach`, err)
      }
    }

    case `validate`: {
      const { target } = command

      try {
        switch (target.target) {
          case `retry-options`: {
            return {
              type: `validate`,
              success: true,
            }
          }

          case `idempotent-producer`: {
            const ds = new DurableStream({
              url: `${serverUrl}/test-validate`,
            })

            new IdempotentProducer(ds, target.producerId ?? `test-producer`, {
              epoch: target.epoch,
              maxBatchBytes: target.maxBatchBytes,
            })

            return {
              type: `validate`,
              success: true,
            }
          }

          default:
            return {
              type: `error`,
              success: false,
              commandType: `validate`,
              errorCode: ErrorCodes.NOT_SUPPORTED,
              message: `Unknown validation target: ${(target as { target: string }).target}`,
            }
        }
      } catch (err) {
        return {
          type: `error`,
          success: false,
          commandType: `validate`,
          errorCode: ErrorCodes.INVALID_ARGUMENT,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    }

    default:
      return {
        type: `error`,
        success: false,
        commandType: (command as TestCommand).type,
        errorCode: ErrorCodes.NOT_SUPPORTED,
        message: `Unknown command type: ${(command as { type: string }).type}`,
      }
  }
}

function errorResult(
  commandType: TestCommand[`type`],
  err: unknown
): TestResult {
  if (err instanceof StreamClosedError) {
    return {
      type: `error`,
      success: false,
      commandType,
      status: 409,
      errorCode: ErrorCodes.STREAM_CLOSED,
      message: err.message,
    }
  }

  if (err instanceof DurableStreamError) {
    let errorCode: ErrorCode = ErrorCodes.INTERNAL_ERROR
    let status: number | undefined

    if (err.code === `NOT_FOUND`) {
      errorCode = ErrorCodes.NOT_FOUND
      status = 404
    } else if (err.code === `CONFLICT_EXISTS`) {
      errorCode = ErrorCodes.CONFLICT
      status = 409
    } else if (err.code === `CONFLICT_SEQ`) {
      errorCode = ErrorCodes.SEQUENCE_CONFLICT
      status = 409
    } else if (err.code === `STREAM_CLOSED`) {
      errorCode = ErrorCodes.STREAM_CLOSED
      status = 409
    } else if (err.code === `BAD_REQUEST`) {
      errorCode = ErrorCodes.INVALID_OFFSET
      status = 400
    } else if (err.code === `PARSE_ERROR`) {
      errorCode = ErrorCodes.PARSE_ERROR
    }

    return {
      type: `error`,
      success: false,
      commandType,
      status,
      errorCode,
      message: err.message,
    }
  }

  if (err instanceof FetchError) {
    let errorCode: ErrorCode
    const msg = err.message.toLowerCase()

    if (err.status === 404) {
      errorCode = ErrorCodes.NOT_FOUND
    } else if (err.status === 409) {
      const streamClosedHeader =
        err.headers[`stream-closed`] ?? err.headers[`Stream-Closed`]
      if (streamClosedHeader?.toLowerCase() === `true`) {
        errorCode = ErrorCodes.STREAM_CLOSED
      } else if (msg.includes(`sequence`)) {
        errorCode = ErrorCodes.SEQUENCE_CONFLICT
      } else {
        errorCode = ErrorCodes.CONFLICT
      }
    } else if (err.status === 400) {
      if (msg.includes(`offset`) || msg.includes(`invalid`)) {
        errorCode = ErrorCodes.INVALID_OFFSET
      } else {
        errorCode = ErrorCodes.UNEXPECTED_STATUS
      }
    } else {
      errorCode = ErrorCodes.UNEXPECTED_STATUS
    }

    return {
      type: `error`,
      success: false,
      commandType,
      status: err.status,
      errorCode,
      message: err.message,
    }
  }

  if (err instanceof Error) {
    if (err.message.includes(`ECONNREFUSED`) || err.message.includes(`fetch`)) {
      return {
        type: `error`,
        success: false,
        commandType,
        errorCode: ErrorCodes.NETWORK_ERROR,
        message: err.message,
      }
    }

    if (
      err instanceof SyntaxError ||
      err.name === `SyntaxError` ||
      err.message.includes(`JSON`) ||
      err.message.includes(`parse`) ||
      err.message.includes(`SSE`) ||
      err.message.includes(`control event`)
    ) {
      return {
        type: `error`,
        success: false,
        commandType,
        errorCode: ErrorCodes.PARSE_ERROR,
        message: err.message,
      }
    }

    return {
      type: `error`,
      success: false,
      commandType,
      errorCode: ErrorCodes.INTERNAL_ERROR,
      message: err.message,
    }
  }

  return {
    type: `error`,
    success: false,
    commandType,
    errorCode: ErrorCodes.INTERNAL_ERROR,
    message: String(err),
  }
}

/**
 * Handle benchmark commands with high-resolution timing.
 */
async function handleBenchmark(command: BenchmarkCommand): Promise<TestResult> {
  const { iterationId, operation } = command

  try {
    const startTime = process.hrtime.bigint()
    const metrics: { bytesTransferred?: number; messagesProcessed?: number } =
      {}

    switch (operation.op) {
      case `append`: {
        const url = `${serverUrl}${operation.path}`
        const contentType =
          streamContentTypes.get(operation.path) ?? `application/octet-stream`
        const ds = new DurableStream({ url, contentType })

        const payload = new Uint8Array(operation.size).fill(42)

        await ds.append(payload)
        metrics.bytesTransferred = operation.size
        break
      }

      case `read`: {
        const url = `${serverUrl}${operation.path}`
        const res = await stream({ url, offset: operation.offset, live: false })
        const data = await res.body()
        metrics.bytesTransferred = data.length
        break
      }

      case `roundtrip`: {
        const url = `${serverUrl}${operation.path}`
        const contentType = operation.contentType ?? `application/octet-stream`

        const ds = await DurableStream.create({ url, contentType })

        const payload = new Uint8Array(operation.size).fill(42)

        const readPromise = (async () => {
          const res = await ds.stream({
            live: operation.live ?? `long-poll`,
          })

          return new Promise<Uint8Array>((resolve) => {
            const unsubscribe = res.subscribeBytes(async (chunk) => {
              if (chunk.data.length > 0) {
                unsubscribe()
                res.cancel()
                resolve(chunk.data)
              }
              return Promise.resolve()
            })
          })
        })()

        await ds.append(payload)

        const readData = await readPromise

        metrics.bytesTransferred = operation.size + readData.length
        break
      }

      case `create`: {
        const url = `${serverUrl}${operation.path}`
        await DurableStream.create({
          url,
          contentType: operation.contentType ?? `application/octet-stream`,
        })
        break
      }

      case `throughput_append`: {
        const url = `${serverUrl}${operation.path}`
        const contentType =
          streamContentTypes.get(operation.path) ?? `application/octet-stream`

        try {
          await DurableStream.create({ url, contentType })
        } catch {
          // Stream may already exist
        }

        const ds = new DurableStream({ url, contentType })

        const payload = new Uint8Array(operation.size).fill(42)

        const producer = new IdempotentProducer(ds, `bench-producer`, {
          lingerMs: 0,
          onError: (err) => console.error(`Batch failed:`, err),
        })

        for (let i = 0; i < operation.count; i++) {
          producer.append(payload)
        }

        await producer.flush()

        metrics.bytesTransferred = operation.count * operation.size
        metrics.messagesProcessed = operation.count
        break
      }

      case `throughput_read`: {
        const url = `${serverUrl}${operation.path}`
        const res = await stream({ url, live: false })
        let count = 0
        let bytes = 0
        for await (const msg of res.jsonStream()) {
          count++
          bytes += JSON.stringify(msg).length
        }
        metrics.bytesTransferred = bytes
        metrics.messagesProcessed = count
        break
      }

      default: {
        return {
          type: `error`,
          success: false,
          commandType: `benchmark`,
          errorCode: ErrorCodes.NOT_SUPPORTED,
          message: `Unknown benchmark operation: ${(operation as BenchmarkOperation).op}`,
        }
      }
    }

    const endTime = process.hrtime.bigint()
    const durationNs = endTime - startTime

    return {
      type: `benchmark`,
      success: true,
      iterationId,
      durationNs: durationNs.toString(),
      metrics,
    }
  } catch (err) {
    return {
      type: `error`,
      success: false,
      commandType: `benchmark`,
      errorCode: ErrorCodes.INTERNAL_ERROR,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

async function main(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  for await (const line of rl) {
    if (!line.trim()) continue

    try {
      const command = parseCommand(line)
      const result = await handleCommand(command)
      console.log(serializeResult(result))

      // Exit after shutdown command
      if (command.type === `shutdown`) {
        break
      }
    } catch (err) {
      console.log(
        serializeResult({
          type: `error`,
          success: false,
          commandType: `init`,
          errorCode: ErrorCodes.PARSE_ERROR,
          message: `Failed to parse command: ${err}`,
        })
      )
    }
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(`Fatal error:`, err)
  process.exit(1)
})
