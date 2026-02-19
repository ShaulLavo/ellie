/**
 * FetchStreamTransport — StreamTransport implementation using plain fetch.
 *
 * Replaces TreatyStreamTransport with a lightweight, framework-independent
 * HTTP client that speaks the DurableStream protocol directly.
 *
 * No body-consuming proxy hacks needed: each fetch() call returns a fresh
 * Response that the protocol layer can read directly.
 *
 * Usage:
 * ```typescript
 * const transport = new FetchStreamTransport({
 *   baseUrl: window.location.origin,
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
// Constructor options
// ============================================================================

export interface FetchStreamTransportOptions {
  /** Base URL of the server (e.g. "http://localhost:4437" or window.location.origin). */
  baseUrl: string
  /** The logical stream path (e.g. "chat/room-1"). */
  streamId: string
}

// ============================================================================
// Implementation
// ============================================================================

export class FetchStreamTransport implements StreamTransport {
  readonly #url: string
  readonly #name: string

  constructor(opts: FetchStreamTransportOptions) {
    // Build the canonical URL for this stream: /chat/room-1 → baseUrl/chat/room-1
    // The server routes /chat/:id and /streams/* both work; we use the direct path.
    const base = opts.baseUrl.replace(/\/$/, ``)
    const streamPath = opts.streamId.startsWith(`/`) ? opts.streamId : `/${opts.streamId}`
    this.#url = `${base}${streamPath}`
    this.#name = opts.streamId
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

    return fetch(this.#url, {
      method: `PUT`,
      headers,
      body: opts.body,
      signal: opts.signal,
    })
  }

  // --------------------------------------------------------------------------
  // HEAD — check stream existence
  // --------------------------------------------------------------------------

  async head(opts: TransportHeadOptions): Promise<Response> {
    return fetch(this.#url, {
      method: `HEAD`,
      signal: opts.signal,
    })
  }

  // --------------------------------------------------------------------------
  // POST — append data
  // --------------------------------------------------------------------------

  async append(opts: TransportAppendOptions): Promise<Response> {
    return fetch(this.#url, {
      method: `POST`,
      headers: opts.headers,
      body: opts.body,
      signal: opts.signal,
    })
  }

  // --------------------------------------------------------------------------
  // POST with Stream-Closed — close stream
  // --------------------------------------------------------------------------

  async close(opts: TransportCloseOptions): Promise<Response> {
    return fetch(this.#url, {
      method: `POST`,
      headers: opts.headers,
      body: opts.body,
      signal: opts.signal,
    })
  }

  // --------------------------------------------------------------------------
  // DELETE — delete stream
  // --------------------------------------------------------------------------

  async delete(opts: TransportDeleteOptions): Promise<Response> {
    return fetch(this.#url, {
      method: `DELETE`,
      signal: opts.signal,
    })
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

    const firstUrl = buildUrl(this.#url, query)
    const firstResponse = await fetch(firstUrl, {
      method: `GET`,
      headers: resolvedHeaders,
      signal: opts.signal,
    })

    if (!firstResponse.ok) {
      await handleErrorResponse(firstResponse, this.#name)
    }

    // Build fetchNext callback for long-poll continuation
    const fetchNext = async (
      offset: Offset,
      cursor: string | undefined,
      signal: AbortSignal,
      resumingFromPause?: boolean,
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

      const nextUrl = buildUrl(this.#url, nextQuery)
      const response = await fetch(nextUrl, {
        method: `GET`,
        headers: nextHeaders,
        signal,
      })

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
            signal: AbortSignal,
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

            const sseUrl = buildUrl(this.#url, sseQuery)
            const response = await fetch(sseUrl, {
              method: `GET`,
              headers: sseHeaders,
              signal,
            })

            if (!response.ok) {
              await handleErrorResponse(response, this.#name)
            }

            return response
          }
        : undefined

    return { firstResponse, fetchNext, startSSE }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function buildUrl(base: string, query: Record<string, string>): string {
  const params = new URLSearchParams(query)
  return `${base}?${params.toString()}`
}
