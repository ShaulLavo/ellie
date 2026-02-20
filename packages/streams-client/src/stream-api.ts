/**
 * Standalone stream() function - the fetch-like read API.
 *
 * This is the primary API for consumers who only need to read from streams.
 */

import {
  LIVE_QUERY_PARAM,
  OFFSET_QUERY_PARAM,
  STREAM_CLOSED_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_SSE_DATA_ENCODING_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "./constants"
import { DurableStreamError, FetchBackoffAbortError } from "./error"
import { BackoffDefaults, createFetchWithBackoff } from "./fetch"
import { StreamResponseImpl } from "./response"
import {
  handleErrorResponse,
  parseUrl,
  resolveFromSplit,
  splitRecord,
  warnIfUsingHttpInBrowser,
} from "./utils"
import type { LiveMode, Offset, StreamOptions, StreamResponse } from "./types"

/**
 * Forward an AbortSignal to an AbortController, handling already-aborted signals.
 */
function forwardAbortSignal(signal: AbortSignal, controller: AbortController): void {
  if (signal.aborted) {
    controller.abort(signal.reason)
    return
  }
  signal.addEventListener(`abort`, () => controller.abort(signal.reason), { once: true })
}

/**
 * Set the live query param on a URL based on the live mode.
 */
function setLiveQueryParam(url: URL, live: LiveMode): void {
  if (live === `sse`) {
    url.searchParams.set(LIVE_QUERY_PARAM, `sse`)
    return
  }
  if (live === true || live === `long-poll`) {
    url.searchParams.set(LIVE_QUERY_PARAM, `long-poll`)
  }
}

/**
 * Try to recover from an error using the onError handler.
 * Returns updated headers/params if retrying, or null to stop.
 */
async function handleOnError(
  onError: StreamOptions[`onError`],
  err: unknown,
  currentHeaders: StreamOptions[`headers`],
  currentParams: StreamOptions[`params`]
): Promise<{ headers: StreamOptions[`headers`]; params: StreamOptions[`params`] } | null> {
  if (!onError) return null

  const retryOpts = await onError(
    err instanceof Error ? err : new Error(String(err))
  )
  if (retryOpts === undefined) return null

  return {
    headers: retryOpts.headers ? { ...currentHeaders, ...retryOpts.headers } : currentHeaders,
    params: retryOpts.params ? { ...currentParams, ...retryOpts.params } : currentParams,
  }
}

/**
 * Create a streaming session to read from a durable stream.
 *
 * This is a fetch-like API:
 * - The promise resolves after the first network request succeeds
 * - It rejects for auth/404/other protocol errors
 * - Returns a StreamResponse for consuming the data
 *
 * @example
 * ```typescript
 * // Catch-up JSON:
 * const res = await stream<{ message: string }>({
 *   url,
 *   auth,
 *   offset: "0",
 *   live: false,
 * })
 * const items = await res.json()
 *
 * // Live JSON:
 * const live = await stream<{ message: string }>({
 *   url,
 *   auth,
 *   offset: savedOffset,
 *   live: true,
 * })
 * live.subscribeJson(async (batch) => {
 *   for (const item of batch.items) {
 *     handle(item)
 *   }
 * })
 * ```
 */
export async function stream<TJson = unknown>(
  options: StreamOptions
): Promise<StreamResponse<TJson>> {
  // Validate options
  if (!options.url) {
    throw new DurableStreamError(
      `Invalid stream options: missing required url parameter`,
      `BAD_REQUEST`
    )
  }

  // Mutable options that can be updated by onError handler
  let currentHeaders = options.headers
  let currentParams = options.params

  // Retry loop for onError handling
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    try {
      return await streamInternal<TJson>({
        ...options,
        headers: currentHeaders,
        params: currentParams,
      })
    } catch (err) {
      const updated = await handleOnError(options.onError, err, currentHeaders, currentParams)
      if (!updated) throw err
      currentHeaders = updated.headers
      currentParams = updated.params
    }
  }
}

/**
 * Internal implementation of stream that doesn't handle onError retries.
 */
async function streamInternal<TJson = unknown>(
  options: StreamOptions
): Promise<StreamResponse<TJson>> {
  // Normalize URL
  const url = options.url instanceof URL ? options.url.toString() : options.url

  // Warn if using HTTP in browser (can cause connection limit issues)
  warnIfUsingHttpInBrowser(url, options.warnOnHttp)

  // Split headers/params once — static values are returned directly on each resolve
  const headersSplit = splitRecord(options.headers)
  const paramsSplit = splitRecord(options.params, true)

  // Build the first request
  const fetchUrl = parseUrl(url)

  // Set offset query param
  const startOffset = options.offset ?? `-1`
  fetchUrl.searchParams.set(OFFSET_QUERY_PARAM, startOffset)

  // Set live query param for explicit modes
  // true means auto-select (no query param, handled by consumption method)
  const live: LiveMode = options.live ?? true
  if (live === `long-poll` || live === `sse`) {
    fetchUrl.searchParams.set(LIVE_QUERY_PARAM, live)
  }

  // Add custom params
  const params = await resolveFromSplit(paramsSplit)
  for (const [key, value] of Object.entries(params)) {
    fetchUrl.searchParams.set(key, value)
  }

  // Build headers
  const headers = await resolveFromSplit(headersSplit)

  // Create abort controller
  const abortController = new AbortController()
  if (options.signal) {
    forwardAbortSignal(options.signal, abortController)
  }

  // Get fetch client with backoff
  const baseFetchClient =
    options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const backoffOptions = options.backoffOptions ?? BackoffDefaults
  const fetchClient = createFetchWithBackoff(baseFetchClient, backoffOptions)

  // Make the first request
  // Backoff client will throw FetchError for non-OK responses
  let firstResponse: Response
  try {
    firstResponse = await fetchClient(fetchUrl.toString(), {
      method: `GET`,
      headers,
      signal: abortController.signal,
    })
  } catch (err) {
    if (err instanceof FetchBackoffAbortError) {
      throw new DurableStreamError(`Stream request was aborted`, `UNKNOWN`)
    }
    // Let other errors (including FetchError) propagate to onError handler
    throw err
  }

  // Extract metadata from headers
  const contentType = firstResponse.headers.get(`content-type`) ?? undefined
  const initialOffset =
    firstResponse.headers.get(STREAM_OFFSET_HEADER) ?? startOffset
  const initialCursor =
    firstResponse.headers.get(STREAM_CURSOR_HEADER) ?? undefined
  const initialUpToDate = firstResponse.headers.has(STREAM_UP_TO_DATE_HEADER)
  const initialStreamClosed =
    firstResponse.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`

  // Determine if JSON mode
  const isJsonMode =
    options.json === true ||
    (contentType?.includes(`application/json`) ?? false)

  // Detect SSE data encoding from response header (server auto-sets for binary streams)
  const sseDataEncoding = firstResponse.headers.get(
    STREAM_SSE_DATA_ENCODING_HEADER
  )
  const encoding =
    sseDataEncoding === `base64` ? (`base64` as const) : undefined

  // Create the fetch function for subsequent requests
  const fetchNext = async (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal,
    resumingFromPause?: boolean
  ): Promise<Response> => {
    const nextUrl = parseUrl(url)
    nextUrl.searchParams.set(OFFSET_QUERY_PARAM, offset)

    // For subsequent requests, set live mode unless resuming from pause
    // (resuming from pause needs immediate response for UI status)
    if (!resumingFromPause) {
      setLiveQueryParam(nextUrl, live)
    }

    if (cursor) {
      nextUrl.searchParams.set(`cursor`, cursor)
    }

    // Resolve params per-request (for dynamic values)
    const nextParams = await resolveFromSplit(paramsSplit)
    for (const [key, value] of Object.entries(nextParams)) {
      nextUrl.searchParams.set(key, value)
    }

    const nextHeaders = await resolveFromSplit(headersSplit)

    const response = await fetchClient(nextUrl.toString(), {
      method: `GET`,
      headers: nextHeaders,
      signal,
    })

    if (!response.ok) {
      await handleErrorResponse(response, url)
    }

    return response
  }

  // Create SSE start function (for SSE mode reconnection)
  const startSSE =
    live === `sse`
      ? async (
          offset: Offset,
          cursor: string | undefined,
          signal: AbortSignal
        ): Promise<Response> => {
          const sseUrl = parseUrl(url)
          sseUrl.searchParams.set(OFFSET_QUERY_PARAM, offset)
          sseUrl.searchParams.set(LIVE_QUERY_PARAM, `sse`)
          if (cursor) {
            sseUrl.searchParams.set(`cursor`, cursor)
          }

          // Resolve params per-request (for dynamic values)
          const sseParams = await resolveFromSplit(paramsSplit)
          for (const [key, value] of Object.entries(sseParams)) {
            sseUrl.searchParams.set(key, value)
          }

          const sseHeaders = await resolveFromSplit(headersSplit)

          const response = await fetchClient(sseUrl.toString(), {
            method: `GET`,
            headers: sseHeaders,
            signal,
          })

          if (!response.ok) {
            await handleErrorResponse(response, url)
          }

          return response
        }
      : undefined

  // Create and return the StreamResponse
  return new StreamResponseImpl<TJson>({
    url,
    contentType,
    live,
    startOffset,
    isJsonMode,
    initialOffset,
    initialCursor,
    initialUpToDate,
    initialStreamClosed,
    firstResponse,
    abortController,
    fetchNext,
    startSSE,
    sseResilience: options.sseResilience,
    encoding,
  })
}
