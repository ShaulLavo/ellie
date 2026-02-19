/**
 * TreatyStreamTransport — StreamTransport implementation using Elysia Treaty RPC.
 *
 * Instead of building raw HTTP requests with URLs and headers, this transport
 * delegates to a Treaty client which provides type-safe RPC calls that resolve
 * to the same Response objects the protocol expects.
 *
 * Usage (endpoint factory — preferred):
 * ```typescript
 * const transport = new TreatyStreamTransport({
 *   endpoint: () => api.chat({ id: "room-1" }),
 *   name: "chat/room-1",
 * })
 * ```
 *
 * Usage (legacy — streams({ id }) shape):
 * ```typescript
 * const transport = new TreatyStreamTransport({
 *   treaty: api,
 *   streamId: "chat/room-1",
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
  get: (opts?: TreatyGetOptions) => Promise<TreatyResult | Response>
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

/**
 * Treaty GET options. Supports `getRaw` to bypass body consumption —
 * essential for streaming responses where the body must remain unread.
 */
interface TreatyGetOptions extends TreatyRequestOptions {
  $query?: Record<string, string>
  $headers?: Record<string, string>
  $fetch?: RequestInit
  getRaw?: boolean
}

interface TreatyResult {
  data: unknown
  error: unknown
  status: number
  response: Response
  headers: HeadersInit | Record<string, string> | undefined
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

/** Direct endpoint factory — works with any Treaty route shape. */
export interface TreatyEndpointTransportOptions {
  /** Factory that returns a TreatyStreamEndpoint. Called for each operation. */
  endpoint: () => TreatyStreamEndpoint
  /** Descriptive name for error messages (e.g. "chat/room-1"). */
  name?: string
}

/** Legacy: derive endpoint from `treaty.streams({ id })`. */
export interface TreatyStreamsTransportOptions {
  /** The Treaty client instance with `streams({ id })` route. */
  treaty: TreatyWithStreams
  /** The logical stream path (e.g. "chat/room-1"). URL-encoded for the route param. */
  streamId: string
}

export type TreatyStreamTransportOptions =
  | TreatyEndpointTransportOptions
  | TreatyStreamsTransportOptions

// ============================================================================
// Implementation
// ============================================================================

export class TreatyStreamTransport implements StreamTransport {
  readonly #endpointFactory: () => TreatyStreamEndpoint
  readonly #name: string

  constructor(opts: TreatyStreamTransportOptions) {
    if (`endpoint` in opts) {
      this.#endpointFactory = opts.endpoint
      this.#name = opts.name ?? `treaty-stream`
    } else {
      const encodedId = encodeURIComponent(opts.streamId)
      this.#endpointFactory = () => opts.treaty.streams({ id: encodedId })
      this.#name = opts.streamId
    }
  }

  #endpoint(): TreatyStreamEndpoint {
    return this.#endpointFactory()
  }

  /**
   * Call a Treaty method and return the raw Response.
   *
   * Treaty tries to JSON-parse every response body, which throws on empty
   * or non-JSON bodies (e.g. a 201 with no body from PUT create). When that
   * happens, we surface a descriptive error rather than the cryptic
   * "Cannot read properties of undefined".
   */
  async #call(
    fn: () => Promise<TreatyResult>,
    operation: string,
  ): Promise<Response> {
    let result: TreatyResult | undefined
    try {
      result = await fn()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        `[TreatyStreamTransport] ${operation} failed for "${this.#name}": ${detail}`,
      )
    }

    if (result.response) return result.response

    let detail = `no response`
    if (result.error instanceof Error) {
      detail = result.error.message
    } else if (result.error) {
      detail = JSON.stringify(result.error)
    }

    throw new Error(
      `[TreatyStreamTransport] ${operation} failed for "${this.#name}": ${detail}`,
    )
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

    return this.#call(
      () => this.#endpoint().put(opts.body ?? null, {
        headers,
        fetch: { signal: opts.signal },
      }),
      `create`,
    )
  }

  // --------------------------------------------------------------------------
  // HEAD — check stream existence
  // --------------------------------------------------------------------------

  async head(opts: TransportHeadOptions): Promise<Response> {
    return this.#call(
      () => this.#endpoint().head({
        fetch: { signal: opts.signal },
      }),
      `head`,
    )
  }

  // --------------------------------------------------------------------------
  // POST — append data
  // --------------------------------------------------------------------------

  async append(opts: TransportAppendOptions): Promise<Response> {
    return this.#call(
      () => this.#endpoint().post(opts.body, {
        headers: opts.headers,
        fetch: { signal: opts.signal },
      }),
      `append`,
    )
  }

  // --------------------------------------------------------------------------
  // POST with Stream-Closed — close stream
  // --------------------------------------------------------------------------

  async close(opts: TransportCloseOptions): Promise<Response> {
    return this.#call(
      () => this.#endpoint().post(opts.body ?? null, {
        headers: opts.headers,
        fetch: { signal: opts.signal },
      }),
      `close`,
    )
  }

  // --------------------------------------------------------------------------
  // DELETE — delete stream
  // --------------------------------------------------------------------------

  async delete(opts: TransportDeleteOptions): Promise<Response> {
    return this.#call(
      () => this.#endpoint().delete({
        fetch: { signal: opts.signal },
      }),
      `delete`,
    )
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

    // Use getRaw to get the raw Response without Treaty consuming the body.
    // This is essential — Treaty would otherwise call .json() or .text() on
    // the response, destroying the body stream that DurableStream needs.
    const firstResponse = await this.#endpoint().get({
      $headers: resolvedHeaders,
      $query: query,
      $fetch: { signal: opts.signal },
      getRaw: true,
    }) as Response

    if (!firstResponse.ok) {
      await handleErrorResponse(firstResponse, this.#name)
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

      const response = await endpoint.get({
        $headers: nextHeaders,
        $query: nextQuery,
        $fetch: { signal },
        getRaw: true,
      }) as Response

      if (!response.ok) {
        await handleErrorResponse(response, this.#name)
      }

      return response
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

            const response = await endpoint.get({
              $headers: sseHeaders,
              $query: sseQuery,
              $fetch: { signal },
              getRaw: true,
            }) as Response

            if (!response.ok) {
              await handleErrorResponse(response, this.#name)
            }

            return response
          }
        : undefined

    return {
      firstResponse,
      fetchNext,
      startSSE,
    }
  }
}
