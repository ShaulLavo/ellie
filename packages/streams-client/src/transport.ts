/**
 * StreamTransport — pluggable transport interface for DurableStream.
 *
 * Allows DurableStream to operate over raw HTTP (default) or
 * alternative transports like Elysia Treaty RPC.
 *
 * Each method returns a standard Response so that the existing
 * header-extraction and StreamResponseImpl logic works unchanged.
 */

import type { BackoffOptions } from "./fetch"
import type { HeadersRecord, LiveMode, Offset, ParamsRecord } from "./types"

// ============================================================================
// Transport Option Types
// ============================================================================

export interface TransportCreateOptions {
  contentType?: string
  ttlSeconds?: number
  expiresAt?: string
  body?: BodyInit
  closed?: boolean
  signal?: AbortSignal
}

export interface TransportHeadOptions {
  signal?: AbortSignal
}

export interface TransportAppendOptions {
  body: BodyInit
  headers: Record<string, string>
  signal?: AbortSignal
}

export interface TransportCloseOptions {
  body?: BodyInit
  headers: Record<string, string>
  signal?: AbortSignal
}

export interface TransportDeleteOptions {
  signal?: AbortSignal
}

export interface TransportStreamOptions {
  offset: Offset
  live: LiveMode
  headers?: HeadersRecord
  params?: ParamsRecord
  signal?: AbortSignal
  json?: boolean
  backoffOptions?: BackoffOptions
  warnOnHttp?: boolean
}

// ============================================================================
// Transport Result Types
// ============================================================================

/**
 * Result from transport.stream() — provides everything StreamResponseImpl
 * needs to operate: the first response plus callbacks for continuation.
 */
export interface TransportStreamResult {
  /** The initial Response (already awaited) */
  firstResponse: Response

  /** Callback to fetch the next long-poll chunk */
  fetchNext: (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal,
    resumingFromPause?: boolean
  ) => Promise<Response>

  /** Callback to start/reconnect an SSE connection (undefined if SSE not supported) */
  startSSE?: (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal
  ) => Promise<Response>
}

// ============================================================================
// Transport Interface
// ============================================================================

/**
 * Pluggable transport for DurableStream operations.
 *
 * Implementations must return standard Response objects with the correct
 * protocol headers (Stream-Next-Offset, Stream-Closed, etc.) so that
 * DurableStream and StreamResponseImpl can extract metadata identically
 * regardless of transport.
 */
export interface StreamTransport {
  /** PUT — create a stream (idempotent) */
  create(opts: TransportCreateOptions): Promise<Response>

  /** HEAD — check stream existence and metadata */
  head(opts: TransportHeadOptions): Promise<Response>

  /** POST — append data to a stream */
  append(opts: TransportAppendOptions): Promise<Response>

  /** POST with Stream-Closed header — close a stream */
  close(opts: TransportCloseOptions): Promise<Response>

  /** DELETE — delete a stream */
  delete(opts: TransportDeleteOptions): Promise<Response>

  /**
   * GET — start a streaming read session.
   *
   * Must return a TransportStreamResult providing the initial Response
   * and callbacks for long-poll / SSE continuation.
   */
  stream(opts: TransportStreamOptions): Promise<TransportStreamResult>
}
