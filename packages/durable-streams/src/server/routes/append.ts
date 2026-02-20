import { formatInternalOffset } from "../../store"
import { StoreError, STORE_ERROR_STATUS } from "../../errors"
import type { ProducerValidationResult } from "../../types"
import type { ServerContext, IStreamStore } from "../lib/context"
import {
  STREAM_OFFSET_HEADER,
  STREAM_SEQ_HEADER,
  STREAM_CLOSED_HEADER,
  PRODUCER_ID_HEADER,
  PRODUCER_EPOCH_HEADER,
  PRODUCER_SEQ_HEADER,
  PRODUCER_EXPECTED_SEQ_HEADER,
  PRODUCER_RECEIVED_SEQ_HEADER,
} from "../lib/constants"

/**
 * Maps a non-accepted ProducerValidationResult to its HTTP error response.
 * Returns null for `accepted` status (caller should handle the success path).
 */
function producerErrorResponse(
  producerResult: ProducerValidationResult,
  producerEpoch: number,
  opts: {
    store: IStreamStore
    path: string
    streamClosed?: boolean
    /** Extra headers merged into the duplicate-status 204 response */
    duplicateHeaders?: Record<string, string>
  }
): Response | null {
  switch (producerResult.status) {
    case `accepted`:
      return null

    case `duplicate`: {
      const dupHeaders: Record<string, string> = {
        [PRODUCER_EPOCH_HEADER]: producerEpoch.toString(),
        [PRODUCER_SEQ_HEADER]: producerResult.lastSeq.toString(),
      }
      if (opts.streamClosed) {
        dupHeaders[STREAM_CLOSED_HEADER] = `true`
      }
      Object.assign(dupHeaders, opts.duplicateHeaders)
      return new Response(null, { status: 204, headers: dupHeaders })
    }

    case `stale_epoch`:
      return new Response(`Stale producer epoch`, {
        status: 403,
        headers: {
          "content-type": `text/plain`,
          [PRODUCER_EPOCH_HEADER]: producerResult.currentEpoch.toString(),
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

    case `stream_closed`: {
      const stream = opts.store.get(opts.path)
      return new Response(`Stream is closed`, {
        status: 409,
        headers: {
          "content-type": `text/plain`,
          [STREAM_CLOSED_HEADER]: `true`,
          [STREAM_OFFSET_HEADER]: stream
            ? formatInternalOffset(stream.currentOffset)
            : ``,
        },
      })
    }
  }
}

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

      if (closeResult.producerResult) {
        const errorResp = producerErrorResponse(
          closeResult.producerResult,
          producerEpoch!,
          {
            store: ctx.store,
            path,
            streamClosed: true,
            duplicateHeaders: {
              [STREAM_OFFSET_HEADER]: closeResult.finalOffset,
            },
          }
        )
        if (errorResp) return errorResp
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
    if (err instanceof StoreError) {
      return new Response(err.message, {
        status: STORE_ERROR_STATUS[err.code],
        headers: { "content-type": `text/plain` },
      })
    }
    throw err
  }

  const { message, producerResult, streamClosed } = result

  // Handle append to closed stream (no message produced)
  if (streamClosed && !message) {
    const stream = ctx.store.get(path)
    const closedOffset = stream ? formatInternalOffset(stream.currentOffset) : ``

    if (producerResult) {
      const errorResp = producerErrorResponse(
        producerResult,
        producerEpoch!,
        {
          store: ctx.store,
          path,
          streamClosed: true,
          duplicateHeaders: { [STREAM_OFFSET_HEADER]: closedOffset },
        }
      )
      if (errorResp) return errorResp
    }

    return new Response(`Stream is closed`, {
      status: 409,
      headers: {
        "content-type": `text/plain`,
        [STREAM_CLOSED_HEADER]: `true`,
        [STREAM_OFFSET_HEADER]: closedOffset,
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
  return producerErrorResponse(
    producerResult,
    producerEpoch!,
    { store: ctx.store, path, streamClosed }
  ) ?? new Response(null, { status: 204 })
}
