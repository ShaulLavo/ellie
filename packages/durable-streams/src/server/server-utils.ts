import { StreamStore } from "../store"
import type { CursorOptions } from "../cursor"

// ── Protocol headers ─────────────────────────────────────────────────
export const STREAM_OFFSET_HEADER = `Stream-Next-Offset`
export const STREAM_CURSOR_HEADER = `Stream-Cursor`
export const STREAM_UP_TO_DATE_HEADER = `Stream-Up-To-Date`
export const STREAM_SEQ_HEADER = `Stream-Seq`
export const STREAM_TTL_HEADER = `Stream-TTL`
export const STREAM_EXPIRES_AT_HEADER = `Stream-Expires-At`
export const STREAM_SSE_DATA_ENCODING_HEADER = `Stream-SSE-Data-Encoding`
export const STREAM_CLOSED_HEADER = `Stream-Closed`

// Idempotent producer headers
export const PRODUCER_ID_HEADER = `Producer-Id`
export const PRODUCER_EPOCH_HEADER = `Producer-Epoch`
export const PRODUCER_SEQ_HEADER = `Producer-Seq`
export const PRODUCER_EXPECTED_SEQ_HEADER = `Producer-Expected-Seq`
export const PRODUCER_RECEIVED_SEQ_HEADER = `Producer-Received-Seq`

// SSE control event fields
export const SSE_OFFSET_FIELD = `streamNextOffset`
export const SSE_CURSOR_FIELD = `streamCursor`
export const SSE_UP_TO_DATE_FIELD = `upToDate`
export const SSE_CLOSED_FIELD = `streamClosed`

// Query params
export const OFFSET_QUERY_PARAM = `offset`
export const LIVE_QUERY_PARAM = `live`
export const CURSOR_QUERY_PARAM = `cursor`

// ── CORS / security headers ──────────────────────────────────────────
export function setDurableStreamHeaders(
  headers: Record<string, string | number>
): void {
  headers[`access-control-allow-origin`] = `*`
  headers[`access-control-allow-methods`] =
    `GET, POST, PUT, DELETE, HEAD, OPTIONS`
  headers[`access-control-allow-headers`] =
    `content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq`
  headers[`access-control-expose-headers`] =
    `Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, Stream-Closed, Producer-Epoch, Producer-Seq, Producer-Expected-Seq, Producer-Received-Seq, etag, content-type, content-encoding, vary`
  headers[`x-content-type-options`] = `nosniff`
  headers[`cross-origin-resource-policy`] = `cross-origin`
}

// ── Context / config ─────────────────────────────────────────────────
export interface ServerConfig {
  longPollTimeout: number
  compression: boolean
  cursorOptions: CursorOptions
}

export interface ServerContext {
  store: StreamStore
  config: ServerConfig
  activeSSEResponses: Set<ReadableStreamDefaultController>
  isShuttingDown: boolean
  injectedFaults: Map<string, InjectedFault>
}

export interface InjectedFault {
  status?: number
  count: number
  retryAfter?: number
  delayMs?: number
  dropConnection?: boolean
  truncateBodyBytes?: number
  probability?: number
  method?: string
  corruptBody?: boolean
  jitterMs?: number
  injectSseEvent?: {
    eventType: string
    data: string
  }
}

export function createServerContext(options: {
  longPollTimeout?: number
  compression?: boolean
  cursorOptions?: CursorOptions
} = {}): ServerContext {
  return {
    store: new StreamStore(),
    config: {
      longPollTimeout: options.longPollTimeout ?? 30_000,
      compression: options.compression ?? true,
      cursorOptions: options.cursorOptions ?? {},
    },
    activeSSEResponses: new Set(),
    isShuttingDown: false,
    injectedFaults: new Map(),
  }
}

export function consumeInjectedFault(
  ctx: ServerContext,
  path: string,
  method: string
): InjectedFault | null {
  const fault = ctx.injectedFaults.get(path)
  if (!fault) return null

  if (fault.method && fault.method.toUpperCase() !== method.toUpperCase()) {
    return null
  }

  if (fault.probability !== undefined && Math.random() > fault.probability) {
    return null
  }

  fault.count--
  if (fault.count <= 0) {
    ctx.injectedFaults.delete(path)
  }

  return fault
}

// ── SSE encoding ─────────────────────────────────────────────────────
/**
 * Encode data for SSE format.
 * Per SSE spec, each line in the payload needs its own "data:" prefix.
 * This prevents CRLF injection attacks.
 */
export function encodeSSEData(payload: string): string {
  const lines = payload.split(/\r\n|\r|\n/)
  return lines.map((line) => `data:${line}`).join(`\n`) + `\n\n`
}

// ── Compression ──────────────────────────────────────────────────────
export const COMPRESSION_THRESHOLD = 1024

export function getCompressionEncoding(
  acceptEncoding: string | undefined
): `gzip` | `deflate` | null {
  if (!acceptEncoding) return null

  const encodings = acceptEncoding
    .toLowerCase()
    .split(`,`)
    .map((e) => e.trim())

  for (const encoding of encodings) {
    const parts = encoding.split(`;`)
    const name = parts[0]?.trim()
    if (name === `gzip` && !hasQZero(parts)) return `gzip`
  }
  for (const encoding of encodings) {
    const parts = encoding.split(`;`)
    const name = parts[0]?.trim()
    if (name === `deflate` && !hasQZero(parts)) return `deflate`
  }

  return null
}

function hasQZero(parts: string[]): boolean {
  for (let i = 1; i < parts.length; i++) {
    const param = parts[i]!.trim()
    if (param.startsWith(`q=`)) {
      return parseFloat(param.slice(2)) === 0
    }
  }
  return false
}

export function compressData(
  data: Uint8Array,
  encoding: `gzip` | `deflate`
): Uint8Array {
  if (encoding === `gzip`) {
    return Bun.gzipSync(data)
  } else {
    return Bun.deflateSync(data)
  }
}
