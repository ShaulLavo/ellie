/**
 * Shared utility functions for the Durable Streams client.
 */

import { STREAM_CLOSED_HEADER, STREAM_OFFSET_HEADER } from "./constants"
import { DurableStreamError, StreamClosedError } from "./error"
import type { HeadersRecord, MaybePromise, ParamsRecord } from "./types"

// ============================================================================
// SplitRecord — resolve static headers/params once, avoid per-request overhead
// ============================================================================

/**
 * A header/param record split into static string values and dynamic functions.
 * Created once at session start; the static portion is returned directly on
 * the hot path (zero allocation, O(1)) when no dynamic entries exist.
 */
export interface SplitRecord {
  readonly statics: Readonly<Record<string, string>>
  readonly dynamics: ReadonlyArray<
    readonly [string, () => MaybePromise<string>]
  >
  readonly isStatic: boolean
}

const EMPTY_SPLIT: SplitRecord = {
  statics: Object.freeze({}),
  dynamics: [],
  isStatic: true,
}

/**
 * Split a HeadersRecord or ParamsRecord into static and dynamic parts.
 * Call once at session/construction time; pass the result to `resolveFromSplit`
 * on every request.
 *
 * @param record - The headers or params record to split
 * @param skipUndefined - When true (use for ParamsRecord), skip undefined values
 */
export function splitRecord(
  record: HeadersRecord | ParamsRecord | undefined,
  skipUndefined?: boolean
): SplitRecord {
  if (!record) {
    return EMPTY_SPLIT
  }

  const statics: Record<string, string> = {}
  const dynamics: Array<[string, () => MaybePromise<string>]> = []

  for (const [key, value] of Object.entries(record)) {
    if (skipUndefined && value === undefined) {
      continue
    }
    if (typeof value === `function`) {
      dynamics.push([key, value])
    } else {
      statics[key] = value as string
    }
  }

  return {
    statics,
    dynamics,
    isStatic: dynamics.length === 0,
  }
}

/**
 * Resolve a SplitRecord to a plain `Record<string, string>`.
 *
 * - **Static fast path** (95% case): returns the cached `statics` object
 *   directly — zero allocation, no iteration, no awaits.
 * - **Dynamic path**: copies statics via spread, then resolves each dynamic
 *   function entry.
 *
 * Callers that need to **mutate** the result (e.g. adding `content-type`)
 * must spread it themselves: `{ ...await resolveFromSplit(split) }`.
 */
export function resolveFromSplit(
  split: SplitRecord
): Record<string, string> | Promise<Record<string, string>> {
  if (split.isStatic) {
    return split.statics as Record<string, string>
  }
  return resolveFromSplitAsync(split)
}

async function resolveFromSplitAsync(
  split: SplitRecord
): Promise<Record<string, string>> {
  const result: Record<string, string> = { ...split.statics }
  for (const [key, fn] of split.dynamics) {
    result[key] = await fn()
  }
  return result
}

/**
 * Handle error responses from the server.
 * Throws appropriate DurableStreamError based on status code.
 */
export async function handleErrorResponse(
  response: Response,
  url: string,
  context?: { operation?: string }
): Promise<never> {
  const status = response.status

  if (status === 404) {
    throw new DurableStreamError(`Stream not found: ${url}`, `NOT_FOUND`, 404)
  }

  if (status === 409) {
    // Check if this is a stream closed error
    const streamClosedHeader = response.headers.get(STREAM_CLOSED_HEADER)
    if (streamClosedHeader?.toLowerCase() === `true`) {
      const finalOffset =
        response.headers.get(STREAM_OFFSET_HEADER) ?? undefined
      throw new StreamClosedError(url, finalOffset)
    }

    // Context-specific 409 messages
    const message =
      context?.operation === `create`
        ? `Stream already exists: ${url}`
        : `Sequence conflict: seq is lower than last appended`
    const code =
      context?.operation === `create` ? `CONFLICT_EXISTS` : `CONFLICT_SEQ`
    throw new DurableStreamError(message, code, 409)
  }

  if (status === 400) {
    throw new DurableStreamError(
      `Bad request (possibly content-type mismatch)`,
      `BAD_REQUEST`,
      400
    )
  }

  throw await DurableStreamError.fromResponse(response, url)
}


/**
 * Resolve a value that may be a function returning a promise.
 */
export async function resolveValue<T>(
  value: T | (() => MaybePromise<T>)
): Promise<T> {
  if (typeof value === `function`) {
    return (value as () => MaybePromise<T>)()
  }
  return value
}

// Module-level Set to track origins we've already warned about (prevents log spam)
const warnedOrigins = new Set<string>()

/**
 * Safely read NODE_ENV.
 * process.env is isomorphic — works in Node, Bun, and browsers (bundlers shim it).
 */
function getNodeEnvSafely(): string | undefined {
  if (typeof process !== `undefined`) return process.env.NODE_ENV
  return undefined
}

/**
 * Check if we're in a browser environment.
 */
function isBrowserEnvironment(): boolean {
  return typeof globalThis.window !== `undefined`
}

/**
 * Get window.location.href safely, returning undefined if not available.
 */
function getWindowLocationHref(): string | undefined {
  if (
    typeof globalThis.window !== `undefined` &&
    typeof globalThis.window.location !== `undefined`
  ) {
    return globalThis.window.location.href
  }
  return undefined
}

/**
 * Resolve a URL string, handling relative URLs in browser environments.
 * Returns undefined if the URL cannot be parsed.
 */
function tryAbsoluteUrl(urlString: string): URL | undefined {
  try {
    return new URL(urlString)
  } catch {
    return undefined
  }
}

function tryRelativeUrl(urlString: string): URL | undefined {
  const base = getWindowLocationHref()
  if (!base) return undefined
  try {
    return new URL(urlString, base)
  } catch {
    return undefined
  }
}

function resolveUrlMaybe(urlString: string): URL | undefined {
  return tryAbsoluteUrl(urlString) ?? tryRelativeUrl(urlString)
}

/**
 * Parse a URL string into a URL object, supporting relative URLs in browsers.
 *
 * In browser environments, relative paths like `/chat/room-1` are resolved
 * against `window.location.origin`. In non-browser environments (Node/Bun),
 * the URL must be absolute.
 *
 * @throws {TypeError} If the URL cannot be parsed
 */
export function parseUrl(urlString: string): URL {
  const resolved = resolveUrlMaybe(urlString)
  if (resolved) return resolved
  // Fall through to native constructor for its standard error message
  return new URL(urlString)
}

/**
 * Warn if using HTTP (not HTTPS) URL in a browser environment.
 * HTTP typically limits browsers to ~6 concurrent connections per origin under HTTP/1.1,
 * which can cause slow streams and app freezes with multiple active streams.
 *
 * Features:
 * - Warns only once per origin to prevent log spam
 * - Handles relative URLs by resolving against window.location.href
 * - Safe to call in Node.js environments (no-op)
 * - Skips warning during tests (NODE_ENV=test)
 */
export function warnIfUsingHttpInBrowser(
  url: string | URL,
  warnOnHttp?: boolean
): void {
  // Skip warning if explicitly disabled
  if (warnOnHttp === false) return

  // Skip warning during tests
  const nodeEnv = getNodeEnvSafely()
  if (nodeEnv === `test`) {
    return
  }

  // Only warn in browser environments
  if (
    !isBrowserEnvironment() ||
    typeof console === `undefined` ||
    typeof console.warn !== `function`
  ) {
    return
  }

  // Parse the URL (handles both absolute and relative URLs)
  const urlStr = url instanceof URL ? url.toString() : url
  const parsedUrl = resolveUrlMaybe(urlStr)

  if (!parsedUrl) {
    // Could not parse URL - silently skip
    return
  }

  // Check if URL uses HTTP protocol
  if (parsedUrl.protocol === `http:`) {
    // Only warn once per origin
    if (!warnedOrigins.has(parsedUrl.origin)) {
      warnedOrigins.add(parsedUrl.origin)
      console.warn(
        `[DurableStream] Using HTTP (not HTTPS) typically limits browsers to ~6 concurrent connections per origin under HTTP/1.1. ` +
          `This can cause slow streams and app freezes with multiple active streams. ` +
          `Use HTTPS for HTTP/2 support. See https://electric-sql.com/r/electric-http2 for more information.`
      )
    }
  }
}

/**
 * Reset the HTTP warning state. Only exported for testing purposes.
 * @internal
 */
export function _resetHttpWarningForTesting(): void {
  warnedOrigins.clear()
}
