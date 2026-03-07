import { describe, expect, test } from 'bun:test'
import { guardedFetch } from './fetch-guard'
import { SsrFBlockedError, type LookupFn } from './ssrf'

// Mock DNS that maps hostnames to IPs
function createMockLookup(
	map: Record<string, string>
): LookupFn {
	return (async (
		hostname: string,
		options: { all?: boolean } | number | undefined
	) => {
		const ip = map[hostname as string]
		if (!ip) throw new Error(`ENOTFOUND: ${hostname}`)
		const family = ip.includes(':') ? 6 : 4
		if (typeof options === 'object' && options?.all) {
			return [{ address: ip, family }]
		}
		return { address: ip, family }
	}) as unknown as LookupFn
}

// Mock fetch that returns controlled responses
function createMockFetch(
	handler: (url: string) => {
		status: number
		headers?: Record<string, string>
		body?: string
	}
) {
	return async (
		input: RequestInfo | URL,
		_init?: RequestInit
	): Promise<Response> => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.toString()
					: input.url
		const result = handler(url)
		return new Response(result.body ?? '', {
			status: result.status,
			headers: result.headers ?? {}
		})
	}
}

describe('guardedFetch', () => {
	const publicLookup = createMockLookup({
		'example.com': '93.184.216.34',
		'redirect.com': '93.184.216.35',
		'loop.com': '93.184.216.36'
	})

	const privateLookup = createMockLookup({
		'evil.com': '127.0.0.1',
		'metadata.com': '169.254.169.254',
		'internal.com': '10.0.0.1',
		'example.com': '93.184.216.34',
		'redirect-evil.com': '93.184.216.35'
	})

	// ── Blocked URLs ──────────────────────────────────────────────

	test('blocks URL resolving to private IP', async () => {
		const mockFetch = createMockFetch(() => ({
			status: 200,
			body: 'ok'
		}))

		await expect(
			guardedFetch('https://evil.com/path', {
				fetchImpl: mockFetch,
				lookupFn: privateLookup
			})
		).rejects.toThrow(SsrFBlockedError)
	})

	test('blocks localhost URL', async () => {
		await expect(
			guardedFetch('http://localhost:3000/admin', {
				lookupFn: publicLookup
			})
		).rejects.toThrow(SsrFBlockedError)
	})

	test('blocks cloud metadata URL', async () => {
		await expect(
			guardedFetch(
				'http://169.254.169.254/latest/meta-data/',
				{
					lookupFn: privateLookup
				}
			)
		).rejects.toThrow(SsrFBlockedError)
	})

	test('blocks non-http protocols', async () => {
		await expect(
			guardedFetch('ftp://example.com/file', {
				lookupFn: publicLookup
			})
		).rejects.toThrow('Invalid URL: must be http or https')
	})

	test('blocks file:// protocol', async () => {
		await expect(
			guardedFetch('file:///etc/passwd', {
				lookupFn: publicLookup
			})
		).rejects.toThrow('Invalid URL: must be http or https')
	})

	// ── Allowed URLs ──────────────────────────────────────────────

	test('allows public URL', async () => {
		const mockFetch = createMockFetch(() => ({
			status: 200,
			body: 'hello'
		}))

		const result = await guardedFetch(
			'https://example.com',
			{
				fetchImpl: mockFetch,
				lookupFn: publicLookup
			}
		)

		expect(result.response.status).toBe(200)
		expect(result.finalUrl).toBe('https://example.com')
		expect(await result.response.text()).toBe('hello')
	})

	// ── Redirects ─────────────────────────────────────────────────

	test('follows safe redirects', async () => {
		const mockFetch = createMockFetch(url => {
			if (url.includes('redirect.com')) {
				return {
					status: 302,
					headers: {
						location: 'https://example.com/final'
					}
				}
			}
			return { status: 200, body: 'final page' }
		})

		const result = await guardedFetch(
			'https://redirect.com/start',
			{
				fetchImpl: mockFetch,
				lookupFn: publicLookup
			}
		)

		expect(result.response.status).toBe(200)
		expect(result.finalUrl).toBe(
			'https://example.com/final'
		)
	})

	test('blocks redirect to private IP', async () => {
		const mockFetch = createMockFetch(url => {
			if (url.includes('redirect-evil.com')) {
				return {
					status: 302,
					headers: {
						location: 'http://evil.com/admin'
					}
				}
			}
			return { status: 200, body: 'ok' }
		})

		await expect(
			guardedFetch('https://redirect-evil.com/start', {
				fetchImpl: mockFetch,
				lookupFn: privateLookup
			})
		).rejects.toThrow(SsrFBlockedError)
	})

	test('detects redirect loop', async () => {
		const mockFetch = createMockFetch(url => {
			if (url.includes('page-a')) {
				return {
					status: 302,
					headers: {
						location: 'https://loop.com/page-b'
					}
				}
			}
			return {
				status: 302,
				headers: {
					location: 'https://loop.com/page-a'
				}
			}
		})

		await expect(
			guardedFetch('https://loop.com/page-a', {
				fetchImpl: mockFetch,
				lookupFn: publicLookup
			})
		).rejects.toThrow('Redirect loop detected')
	})

	test('enforces max redirects', async () => {
		let counter = 0
		const mockFetch = createMockFetch(() => {
			counter++
			return {
				status: 302,
				headers: {
					location: `https://example.com/hop-${counter}`
				}
			}
		})

		await expect(
			guardedFetch('https://example.com/start', {
				fetchImpl: mockFetch,
				lookupFn: publicLookup,
				maxRedirects: 2
			})
		).rejects.toThrow('Too many redirects (limit: 2)')
	})

	// ── Wildcard allowlist ────────────────────────────────────────

	test('allows hostname matching wildcard allowlist', async () => {
		const mockFetch = createMockFetch(() => ({
			status: 200,
			body: 'ok'
		}))

		const result = await guardedFetch(
			'https://example.com/page',
			{
				fetchImpl: mockFetch,
				lookupFn: publicLookup,
				policy: {
					hostnameAllowlist: ['*.com']
				}
			}
		)
		expect(result.response.status).toBe(200)
	})

	test('blocks hostname not matching wildcard allowlist', async () => {
		const mockFetch = createMockFetch(() => ({
			status: 200,
			body: 'ok'
		}))

		await expect(
			guardedFetch('https://example.com/page', {
				fetchImpl: mockFetch,
				lookupFn: publicLookup,
				policy: {
					hostnameAllowlist: ['*.org']
				}
			})
		).rejects.toThrow(SsrFBlockedError)
	})

	// ── HTTP IP pinning ──────────────────────────────────────────

	test('rewrites HTTP URL to resolved IP with Host header', async () => {
		let capturedUrl = ''
		let capturedHost = ''
		const mockFetch = async (
			input: RequestInfo | URL,
			init?: RequestInit
		): Promise<Response> => {
			capturedUrl =
				typeof input === 'string'
					? input
					: input instanceof URL
						? input.toString()
						: input.url
			const headers = new Headers(init?.headers)
			capturedHost = headers.get('Host') ?? ''
			return new Response('ok', { status: 200 })
		}

		await guardedFetch('http://example.com/path', {
			fetchImpl: mockFetch,
			lookupFn: publicLookup
		})

		// URL should contain the resolved IP, not the hostname
		expect(capturedUrl).toContain('93.184.216.34')
		expect(capturedUrl).not.toContain('example.com')
		// Host header should preserve original hostname
		expect(capturedHost).toBe('example.com')
	})

	test('does NOT rewrite HTTPS URL to IP (TLS needs hostname)', async () => {
		let capturedUrl = ''
		const mockFetch = async (
			input: RequestInfo | URL,
			_init?: RequestInit
		): Promise<Response> => {
			capturedUrl =
				typeof input === 'string'
					? input
					: input instanceof URL
						? input.toString()
						: input.url
			return new Response('ok', { status: 200 })
		}

		await guardedFetch('https://example.com/path', {
			fetchImpl: mockFetch,
			lookupFn: publicLookup
		})

		// HTTPS URL should keep the original hostname
		expect(capturedUrl).toContain('example.com')
		expect(capturedUrl).not.toContain('93.184.216.34')
	})
})
