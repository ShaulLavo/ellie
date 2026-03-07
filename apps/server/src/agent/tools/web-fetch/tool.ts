/**
 * Web fetch tool — fetch and extract readable content from web pages,
 * PDFs, and other resources.
 *
 * Routes by Content-Type:
 *   Reddit    → JSON API → formatted text
 *   Wikipedia → extracts API → formatted text
 *   PDF       → fetch → pdf2md → markdown
 *   media     → fetch → URL reference
 *   markdown  → Accept: text/markdown → direct (Cloudflare etc.)
 *   HTML      → Puppeteer (via worker) → Defuddle → markdown
 */

import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import {
	MAX_CONTENT_CHARS,
	USER_AGENT,
	truncateText,
	errorResult,
	isMediaType,
	wrapExternalContent
} from './common'
import {
	webFetchParams,
	type WebFetchParams
} from './schema'
import {
	handleBrowser,
	handlePdf,
	handleMedia
} from './handlers'
import { isRedditUrl, handleReddit } from './reddit'
import {
	isWikipediaUrl,
	handleWikipedia
} from './wikipedia'
import { guardedFetch } from './fetch-guard'
import { validateHostname, SsrFBlockedError } from './ssrf'
import { getCachedFetchResult } from './fetch-cache'
import type { EventStore } from '@ellie/db'

/**
 * Create the web fetch tool.
 */
export function createWebFetchTool(
	eventStore?: EventStore
): AgentTool {
	return {
		name: 'fetch_page',
		description:
			'Fetch a web page, PDF, or other resource and extract its readable content as markdown. ' +
			'Uses a headless browser to render pages with full JavaScript support. ' +
			'Returns markdown for HTML pages and PDFs, or a URL reference for media files.',
		label: 'Fetching web page',
		parameters: webFetchParams,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as WebFetchParams

			try {
				// Cache check — return recent result if available
				// (already wrapped when originally stored)
				if (eventStore) {
					const cached = getCachedFetchResult(
						eventStore,
						params.url
					)
					if (cached) return cached
				}

				// Reddit — use JSON API directly (no browser needed)
				if (isRedditUrl(params.url)) {
					return wrapExternalContent(
						await handleReddit(params.url)
					)
				}

				// Wikipedia — use REST API (no browser needed)
				if (isWikipediaUrl(params.url)) {
					return wrapExternalContent(
						await handleWikipedia(params.url)
					)
				}

				const { response, finalUrl } = await guardedFetch(
					params.url,
					{
						init: {
							headers: {
								'User-Agent': USER_AGENT,
								Accept:
									'text/markdown, text/html;q=0.9, */*;q=0.8'
							}
						}
					}
				)

				if (!response.ok) {
					return errorResult(
						`HTTP ${response.status} ${response.statusText}`
					)
				}

				const contentType =
					response.headers.get('content-type') ?? ''

				// PDF — fetch raw bytes
				if (contentType.includes('application/pdf')) {
					return wrapExternalContent(
						await handlePdf(response, finalUrl)
					)
				}

				// Media — URL reference (not wrapping — no text content to inject)
				if (isMediaType(contentType)) {
					return handleMedia(
						finalUrl,
						contentType,
						response.headers.get('content-length')
					)
				}

				// Markdown fast-path (Cloudflare "Markdown for Agents" etc.)
				if (contentType.includes('text/markdown')) {
					const raw = await response.text()
					if (raw.trim()) {
						const text = truncateText(
							raw,
							MAX_CONTENT_CHARS
						)
						const tokenCount = response.headers.get(
							'x-markdown-tokens'
						)
						return wrapExternalContent({
							content: [{ type: 'text', text }],
							details: {
								url: finalUrl,
								contentType: 'text/markdown',
								...(tokenCount && {
									tokenCount: parseInt(tokenCount, 10)
								})
							}
						})
					}
					// Empty markdown — fall through to browser
				}

				// HTML — validate URL before passing to Puppeteer worker
				await validateHostname(new URL(params.url).hostname)
				return wrapExternalContent(
					await handleBrowser(params.url)
				)
			} catch (err) {
				if (err instanceof SsrFBlockedError) {
					return errorResult(
						`Blocked by SSRF policy: ${err.message}`
					)
				}
				const msg =
					err instanceof Error ? err.message : String(err)
				return errorResult(msg)
			}
		}
	}
}
