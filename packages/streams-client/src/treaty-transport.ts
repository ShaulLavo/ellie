/**
 * TreatyStreamTransport — StreamTransport implementation using Elysia Treaty RPC.
 *
 * Instead of building raw HTTP requests with URLs and headers, this transport
 * delegates to a Treaty client which provides type-safe RPC calls that resolve
 * to the same Response objects the protocol expects.
 *
 * Usage:
 * ```typescript
 * import { treaty } from "@elysiajs/eden"
 * import type { App } from "./server"
 *
 * const api = treaty<App>("http://localhost:4437")
 * const transport = new TreatyStreamTransport({
 *   treaty: api,
 *   streamId: "chat/room-1",
 * })
 *
 * const stream = await DurableStream.create({
 *   url: "http://localhost:4437/streams/chat%2Froom-1",
 *   transport,
 * })
 * ```
 */

import {
  LIVE_QUERY_PARAM,
  OFFSET_QUERY_PARAM,
  STREAM_CLOSED_HEADER,
  STREAM_EXPIRES_AT_HEADER,
  STREAM_TTL_HEADER,
} from "./constants"
import { handleErrorResponse, resolveFromSplit, splitRecord } from "./utils"
import type {
  StreamTransport,
  TransportAppendOptions,
  TransportCloseOptions,
  TransportCreateOptions,
  TransportDeleteOptions,
  TransportHeadOptions,
  TransportStreamOptions,
  TransportStreamResult,
} from "./transport"
import type { Offset } from "./types"

// ============================================================================
// Treaty type helpers
// ============================================================================

/**
 * Minimal treaty endpoint shape — we only need the HTTP method functions.
 * This avoids coupling to a specific Elysia App type.
 */
interface TreatyStreamEndpoint {
  get: (opts?: TreatyRequestOptions) => Promise<TreatyResult>
  put: (body: unknown, opts?: TreatyRequestOptions) => Promise<TreatyResult>
  post: (body: unknown, opts?: TreatyRequestOptions) => Promise<TreatyResult>
  head: (opts?: TreatyRequestOptions) => Promise<TreatyResult>
  delete: (opts?: TreatyRequestOptions) => Promise<TreatyResult>
}

interface TreatyRequestOptions {
  headers?: Record<string, string>
  query?: Record<string, string>
  fetch?: RequestInit
}

interface TreatyResult {
  data: unknown
  error: unknown
  status: number
  response: Response
  headers: Record<string, string>
}

/**
 * A Treaty client with a `streams` property that accepts an `{ id }` param.
 */
export interface TreatyWithStreams {
  streams: (params: { id: string }) => TreatyStreamEndpoint
}

// ============================================================================
// Constructor options
// ============================================================================

export interface TreatyStreamTransportOptions {
  /**
   * The Treaty client instance.
   * Must have `streams({ id })` route matching the server.
   */
  treaty: TreatyWithStreams

  /**
   * The logical stream path (e.g. "chat/room-1").
   * Will be URL-encoded for the Treaty route param.
   */
  streamId: string

}

// ============================================================================
// Implementation
// ============================================================================

export class TreatyStreamTransport implements StreamTransport {
  readonly #treaty: TreatyWithStreams
  readonly #encodedId: string

  constructor(opts: TreatyStreamTransportOptions) {
    this.#treaty = opts.treaty
    this.#encodedId = encodeURIComponent(opts.streamId)
  }

  #endpoint(): TreatyStreamEndpoint {
    return this.#treaty.streams({ id: this.#encodedId })
  }

  // --------------------------------------------------------------------------
  // PUT — create stream
  // --------------------------------------------------------------------------

  async create(opts: TransportCreateOptions): Promise<Response> {
    const headers: Record<string, string> = {}
    if (opts.contentType) {
      headers[`content-type`] = opts.contentType
    }
    if (opts.ttlSeconds !== undefined) {
      headers[STREAM_TTL_HEADER] = String(opts.ttlSeconds)
    }
    if (opts.expiresAt) {
      headers[STREAM_EXPIRES_AT_HEADER] = opts.expiresAt
    }
    if (opts.closed) {
      headers[STREAM_CLOSED_HEADER] = `true`
    }

    const result = await this.#endpoint().put(opts.body ?? null, {
      headers,
      fetch: { signal: opts.signal },
    })

    return result.response
  }

  // --------------------------------------------------------------------------
  // HEAD — check stream existence
  // --------------------------------------------------------------------------

  async head(opts: TransportHeadOptions): Promise<Response> {
    const result = await this.#endpoint().head({
      fetch: { signal: opts.signal },
    })

    return result.response
  }

  // --------------------------------------------------------------------------
  // POST — append data
  // --------------------------------------------------------------------------

  async append(opts: TransportAppendOptions): Promise<Response> {
    const result = await this.#endpoint().post(opts.body, {
      headers: opts.headers,
      fetch: { signal: opts.signal },
    })

    return result.response
  }

  // --------------------------------------------------------------------------
  // POST with Stream-Closed — close stream
  // --------------------------------------------------------------------------

  async close(opts: TransportCloseOptions): Promise<Response> {
    const result = await this.#endpoint().post(opts.body ?? null, {
      headers: opts.headers,
      fetch: { signal: opts.signal },
    })

    return result.response
  }

  // --------------------------------------------------------------------------
  // DELETE — delete stream
  // --------------------------------------------------------------------------

  async delete(opts: TransportDeleteOptions): Promise<Response> {
    const result = await this.#endpoint().delete({
      fetch: { signal: opts.signal },
    })

    return result.response
  }

  // --------------------------------------------------------------------------
  // GET — streaming read session
  // --------------------------------------------------------------------------

  async stream(opts: TransportStreamOptions): Promise<TransportStreamResult> {
    // Split headers/params once — static values are returned directly on each resolve
    const headersSplit = splitRecord(opts.headers)
    const paramsSplit = splitRecord(opts.params, true)

    const resolvedHeaders = await resolveFromSplit(headersSplit)
    const resolvedParams = await resolveFromSplit(paramsSplit)

    // Build query params
    const query: Record<string, string> = {
      [OFFSET_QUERY_PARAM]: String(opts.offset),
      ...resolvedParams,
    }

    const live = opts.live
    if (live === `long-poll` || live === `sse`) {
      query[LIVE_QUERY_PARAM] = live
    }

    // Make first request via Treaty
    const firstResult = await this.#endpoint().get({
      headers: resolvedHeaders,
      query,
      fetch: { signal: opts.signal },
    })

    const firstResponse = firstResult.response

    if (!firstResponse.ok) {
      await handleErrorResponse(
        firstResponse,
        `streams/${this.#encodedId}`
      )
    }

    // Build fetchNext callback for long-poll continuation
    const endpoint = this.#endpoint()
    const fetchNext = async (
      offset: Offset,
      cursor: string | undefined,
      signal: AbortSignal,
      resumingFromPause?: boolean
    ): Promise<Response> => {
      const nextQuery: Record<string, string> = {
        [OFFSET_QUERY_PARAM]: String(offset),
        ...resolvedParams,
      }

      if (!resumingFromPause) {
        if (live === `sse`) {
          nextQuery[LIVE_QUERY_PARAM] = `sse`
        } else if (live === true || live === `long-poll`) {
          nextQuery[LIVE_QUERY_PARAM] = `long-poll`
        }
      }

      if (cursor) {
        nextQuery[`cursor`] = cursor
      }

      // Re-resolve dynamic headers/params per-request
      const nextHeaders = await resolveFromSplit(headersSplit)
      const nextParams = await resolveFromSplit(paramsSplit)
      Object.assign(nextQuery, nextParams)

      const result = await endpoint.get({
        headers: nextHeaders,
        query: nextQuery,
        fetch: { signal },
      })

      if (!result.response.ok) {
        await handleErrorResponse(result.response, `streams/${this.#encodedId}`)
      }

      return result.response
    }

    // Build startSSE callback for SSE mode
    const startSSE =
      live === `sse`
        ? async (
            offset: Offset,
            cursor: string | undefined,
            signal: AbortSignal
          ): Promise<Response> => {
            const sseQuery: Record<string, string> = {
              [OFFSET_QUERY_PARAM]: String(offset),
              [LIVE_QUERY_PARAM]: `sse`,
              ...resolvedParams,
            }

            if (cursor) {
              sseQuery[`cursor`] = cursor
            }

            const sseHeaders = await resolveFromSplit(headersSplit)
            const sseParams = await resolveFromSplit(paramsSplit)
            Object.assign(sseQuery, sseParams)

            const result = await endpoint.get({
              headers: sseHeaders,
              query: sseQuery,
              fetch: { signal },
            })

            if (!result.response.ok) {
              await handleErrorResponse(
                result.response,
                `streams/${this.#encodedId}`
              )
            }

            return result.response
          }
        : undefined

    return {
      firstResponse,
      fetchNext,
      startSSE,
    }
  }
}
