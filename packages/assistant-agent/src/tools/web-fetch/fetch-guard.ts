/**
 * SSRF-guarded fetch — validates hostname and DNS before every request,
 * follows redirects manually with per-hop re-validation.
 *
 * DNS rebinding mitigation:
 *   For HTTP URLs, the hostname is rewritten to the validated IP address
 *   and the original hostname is sent via the Host header. This pins the
 *   connection to the pre-validated IP, preventing TOCTOU attacks.
 *
 *   For HTTPS URLs, IP rewriting isn't possible (TLS certificate validation
 *   requires the original hostname for SNI). The pre-flight DNS check still
 *   blocks direct private IP access, but a DNS rebinding attack between
 *   validation and fetch is theoretically possible. This is an accepted
 *   limitation — undici DNS pinning is not available in Bun's fetch.
 */

import {
	SsrFBlockedError,
	validateHostname,
	type LookupFn,
	type SsrFPolicy
} from './ssrf'

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit
) => Promise<Response>

type GuardedFetchOptions = {
	fetchImpl?: FetchLike
	init?: RequestInit
	maxRedirects?: number
	timeoutMs?: number
	signal?: AbortSignal
	policy?: SsrFPolicy
	lookupFn?: LookupFn
}

type GuardedFetchResult = {
	response: Response
	finalUrl: string
}

const DEFAULT_MAX_REDIRECTS = 3

function isRedirectStatus(status: number): boolean {
	return (
		status === 301 ||
		status === 302 ||
		status === 303 ||
		status === 307 ||
		status === 308
	)
}

function buildAbortSignal(params: {
	timeoutMs?: number
	signal?: AbortSignal
}): { signal?: AbortSignal; cleanup: () => void } {
	const { timeoutMs, signal } = params
	if (!timeoutMs && !signal)
		return { signal: undefined, cleanup: () => {} }
	if (!timeoutMs) return { signal, cleanup: () => {} }

	const controller = new AbortController()
	// Use .bind() instead of an arrow closure to avoid capturing the
	// surrounding scope (params, signal, etc.), preventing memory leaks
	// when the caller's AbortSignal is long-lived.
	const abort = controller.abort.bind(controller)

	const timeoutId = setTimeout(abort, timeoutMs)
	if (signal) {
		if (signal.aborted) {
			controller.abort()
		} else {
			signal.addEventListener('abort', abort, {
				once: true
			})
		}
	}

	const cleanup = () => {
		clearTimeout(timeoutId)
		signal?.removeEventListener('abort', abort)
	}
	return { signal: controller.signal, cleanup }
}

/**
 * Rewrite an HTTP URL to connect to a specific IP address, preserving
 * the original hostname in the Host header. This pins the connection
 * to the pre-validated IP, preventing DNS rebinding.
 *
 * Only applies to HTTP — HTTPS requires the original hostname for TLS SNI.
 */
function pinHttpUrl(
	parsedUrl: URL,
	resolvedIp: string,
	headers: Headers
): URL {
	if (parsedUrl.protocol !== 'http:') return parsedUrl

	const pinnedUrl = new URL(parsedUrl.toString())
	// Preserve original host (hostname:port) for the Host header
	if (!headers.has('Host')) {
		headers.set('Host', parsedUrl.host)
	}
	// Rewrite hostname to the validated IP
	pinnedUrl.hostname = resolvedIp.includes(':')
		? `[${resolvedIp}]`
		: resolvedIp
	return pinnedUrl
}

/**
 * Fetch a URL with SSRF protection.
 *
 * - Validates protocol (http/https only)
 * - Validates hostname against blocked list
 * - Resolves DNS and checks all IPs against private ranges
 * - Pins HTTP connections to validated IPs (DNS rebinding protection)
 * - Follows redirects manually, re-validating each hop
 * - Detects redirect loops and enforces max redirect count
 */
export async function guardedFetch(
	url: string,
	options: GuardedFetchOptions = {}
): Promise<GuardedFetchResult> {
	const fetcher: FetchLike =
		options.fetchImpl ?? globalThis.fetch
	const maxRedirects =
		typeof options.maxRedirects === 'number' &&
		Number.isFinite(options.maxRedirects)
			? Math.max(0, Math.floor(options.maxRedirects))
			: DEFAULT_MAX_REDIRECTS

	const { signal, cleanup } = buildAbortSignal({
		timeoutMs: options.timeoutMs,
		signal: options.signal
	})

	const visited = new Set<string>()
	let currentUrl = url
	let redirectCount = 0

	try {
		while (true) {
			let parsedUrl: URL
			try {
				parsedUrl = new URL(currentUrl)
			} catch {
				throw new Error(
					'Invalid URL: must be http or https'
				)
			}

			if (
				parsedUrl.protocol !== 'http:' &&
				parsedUrl.protocol !== 'https:'
			) {
				throw new Error(
					'Invalid URL: must be http or https'
				)
			}

			// Pre-flight: validate hostname + DNS, get resolved IPs
			const resolvedIps = await validateHostname(
				parsedUrl.hostname,
				{
					lookupFn: options.lookupFn,
					policy: options.policy
				}
			)

			// Build headers, merging any from init
			const headers = new Headers(options.init?.headers)

			// For HTTP, rewrite URL to validated IP (DNS rebinding protection)
			const fetchUrl = pinHttpUrl(
				parsedUrl,
				resolvedIps[0],
				headers
			)

			const init: RequestInit = {
				...(options.init ? { ...options.init } : {}),
				headers,
				redirect: 'manual',
				...(signal ? { signal } : {})
			}

			const response = await fetcher(
				fetchUrl.toString(),
				init
			)

			if (isRedirectStatus(response.status)) {
				const location = response.headers.get('location')
				if (!location) {
					throw new Error(
						`Redirect missing location header (${response.status})`
					)
				}

				redirectCount += 1
				if (redirectCount > maxRedirects) {
					throw new Error(
						`Too many redirects (limit: ${maxRedirects})`
					)
				}

				const nextUrl = new URL(
					location,
					parsedUrl
				).toString()
				if (visited.has(nextUrl)) {
					throw new Error('Redirect loop detected')
				}
				visited.add(nextUrl)

				// Discard redirect response body
				void response.body?.cancel()
				currentUrl = nextUrl
				continue
			}

			return { response, finalUrl: currentUrl }
		}
	} catch (err) {
		if (err instanceof SsrFBlockedError) {
			console.warn(
				`[ssrf] blocked fetch: url=${currentUrl} reason=${err.message}`
			)
		}
		throw err
	} finally {
		cleanup()
	}
}
