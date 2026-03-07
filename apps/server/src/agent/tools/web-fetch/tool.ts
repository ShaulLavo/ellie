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
	MAX_OUTPUT_CHARS,
	USER_AGENT,
	truncateText,
	errorResult,
	isMediaType
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

/**
 * Create the web fetch tool.
 */
export function createWebFetchTool(): AgentTool {
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
				// Reddit — use JSON API directly (no browser needed)
				if (isRedditUrl(params.url)) {
					return handleReddit(params.url)
				}

				// Wikipedia — use REST API (no browser needed)
				if (isWikipediaUrl(params.url)) {
					return handleWikipedia(params.url)
				}

				const response = await fetch(params.url, {
					headers: {
						'User-Agent': USER_AGENT,
						Accept:
							'text/markdown, text/html;q=0.9, */*;q=0.8'
					},
					redirect: 'follow'
				})

				if (!response.ok) {
					return errorResult(
						`HTTP ${response.status} ${response.statusText}`
					)
				}

				const contentType =
					response.headers.get('content-type') ?? ''

				// PDF — fetch raw bytes
				if (contentType.includes('application/pdf')) {
					return handlePdf(response, params.url)
				}

				// Media — URL reference
				if (isMediaType(contentType)) {
					return handleMedia(
						params.url,
						contentType,
						response.headers.get('content-length')
					)
				}

				// Markdown fast-path (Cloudflare "Markdown for Agents" etc.)
				if (contentType.includes('text/markdown')) {
					const raw = await response.text()
					if (raw.trim()) {
						const text = truncateText(raw, MAX_OUTPUT_CHARS)
						const tokenCount = response.headers.get(
							'x-markdown-tokens'
						)
						return {
							content: [{ type: 'text', text }],
							details: {
								url: params.url,
								contentType: 'text/markdown',
								...(tokenCount && {
									tokenCount: parseInt(tokenCount, 10)
								})
							}
						}
					}
					// Empty markdown — fall through to browser
				}

				// HTML — headless Chrome via worker
				return handleBrowser(params.url)
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : String(err)
				return errorResult(msg)
			}
		}
	}
}
