/**
 * Web fetch tool — fetch and extract readable content from web pages,
 * PDFs, and other resources.
 *
 * Routes by Content-Type:
 *   PDF   → pdf2md → markdown
 *   media → URL reference
 *   HTML  → auto-detects JS-heavy pages:
 *           1. allowlisted domain → Defuddle (static)
 *           2. SPA shell detected → Playwright
 *           3. Defuddle → wordCount < 50 → Playwright retry
 */

import * as v from 'valibot'
import * as Comlink from 'comlink'
import pdf2md from '@opendocsg/pdf2md'
import { getBrowser } from './browser'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import type { DefuddleWorkerApi } from './defuddle.worker'

// ── Schema ──────────────────────────────────────────────────────────────

const webFetchParams = v.object({
	url: v.pipe(
		v.string(),
		v.description('The URL of the web page to fetch')
	)
})

type WebFetchParams = v.InferOutput<typeof webFetchParams>

// ── Constants ───────────────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 50_000

const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const MIN_WORD_COUNT = 50

// ── Static domain allowlist ─────────────────────────────────────────────

/**
 * Domains known to serve static HTML that never needs JS rendering.
 * Exact entries (e.g. 'abc.net.au') match the full hostname suffix.
 * Short entries match the domain name without TLD (e.g. 'wikipedia'
 * matches en.wikipedia.org, ja.wikipedia.org, etc.).
 */
const STATIC_DOMAINS = new Set([
	// exact domains
	'abc.net.au',
	'bsky.app',
	// domain-without-suffix matches
	'apple',
	'arxiv',
	'bbc',
	'blogspot',
	'csdn',
	'deviantart',
	'digg',
	'engadget',
	'etsy',
	'eventbrite',
	'flickr',
	'ghost',
	'giphy',
	'github',
	'gitlab',
	'google',
	'huffingtonpost',
	'imdb',
	'imgur',
	'instagram',
	'meetup',
	'microsoft',
	'nytimes',
	'pinterest',
	'producthunt',
	'reddit',
	'slideshare',
	'soundcloud',
	'sourceforge',
	'spotify',
	'stackoverflow',
	'substack',
	'techcrunch',
	'telegraph',
	'theguardian',
	'theverge',
	'tumblr',
	'vimeo',
	'wikipedia',
	'wordpress',
	'ycombinator',
	'yelp',
	'youtube',
	'zoom'
])

function isStaticDomain(url: string): boolean {
	try {
		const hostname = new URL(url).hostname // e.g. "en.wikipedia.org"
		// Check exact hostname suffix (for multi-part entries like abc.net.au)
		for (const domain of STATIC_DOMAINS) {
			if (domain.includes('.')) {
				// Exact: hostname ends with the domain
				if (
					hostname === domain ||
					hostname.endsWith(`.${domain}`)
				)
					return true
			} else {
				// Suffix-less: any hostname part matches
				const parts = hostname.split('.')
				if (parts.includes(domain)) return true
			}
		}
		return false
	} catch {
		return false
	}
}

// ── SPA detection ───────────────────────────────────────────────────────

function looksLikeSpa(html: string): boolean {
	// Very short body — likely an empty shell
	if (html.length < 1500) return true

	// Has noscript tag — framework fallback for SSR
	if (/<noscript/i.test(html)) return true

	// Framework hydration markers without real article content
	const hasFrameworkMarkers =
		/__NEXT_DATA__|__NUXT__|window\.__/i.test(html)
	const hasArticleContent = /<article/i.test(html)
	return hasFrameworkMarkers && !hasArticleContent
}

// ── Defuddle worker (lazy singleton) ────────────────────────────────────

let workerProxy: Comlink.Remote<DefuddleWorkerApi> | null = null

function getDefuddleWorker(): Comlink.Remote<DefuddleWorkerApi> {
	if (!workerProxy) {
		const worker = new Worker(
			new URL('./defuddle.worker.ts', import.meta.url)
		)
		worker.addEventListener('error', () => {
			workerProxy = null
		})
		workerProxy = Comlink.wrap<DefuddleWorkerApi>(worker)
	}
	return workerProxy
}

// ── Helpers ─────────────────────────────────────────────────────────────

function truncateText(
	text: string,
	maxChars: number
): string {
	return text.length > maxChars
		? text.slice(0, maxChars) +
				`\n... (truncated at ${maxChars} chars)`
		: text
}

function errorResult(msg: string): AgentToolResult {
	return {
		content: [
			{ type: 'text', text: `Web fetch error: ${msg}` }
		],
		details: { success: false, error: msg }
	}
}

function isMediaType(contentType: string): boolean {
	return (
		contentType.startsWith('image/') ||
		contentType.startsWith('video/') ||
		contentType.startsWith('audio/')
	)
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024)
		return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── Handlers ────────────────────────────────────────────────────────────

async function handleHtml(
	html: string,
	url: string
): Promise<AgentToolResult> {
	// 1. Allowlisted domain — always static, skip detection
	if (isStaticDomain(url)) {
		return await htmlToMarkdownResult(html, url)
	}

	// 2. SPA shell — skip Defuddle, go straight to Playwright
	if (looksLikeSpa(html)) {
		return handlePlaywright(url)
	}

	// 3. Try Defuddle — if too little content, retry with Playwright
	const result = await htmlToMarkdownResult(html, url)
	const details = result.details as { wordCount: number }
	if (details.wordCount < MIN_WORD_COUNT) {
		return handlePlaywright(url)
	}

	return result
}

async function handlePlaywright(
	url: string
): Promise<AgentToolResult> {
	const browser = await getBrowser()
	const page = await browser.newPage()

	try {
		await page.goto(url, {
			waitUntil: 'networkidle',
			timeout: 30_000
		})
		const html = await page.content()
		return await htmlToMarkdownResult(html, url)
	} finally {
		await page.close()
	}
}

async function htmlToMarkdownResult(
	html: string,
	url: string
): Promise<AgentToolResult> {
	const worker = getDefuddleWorker()
	const result = await worker.parse(html, url)

	const parts: string[] = []
	if (result.title) parts.push(`# ${result.title}`)
	if (result.author)
		parts.push(`**Author:** ${result.author}`)
	if (result.content) parts.push(result.content)

	const text = parts.join('\n\n')
	const truncated = truncateText(text, MAX_OUTPUT_CHARS)

	return {
		content: [
			{
				type: 'text',
				text: truncated || '(no readable content found)'
			}
		],
		details: {
			url,
			title: result.title,
			author: result.author,
			wordCount: result.wordCount
		}
	}
}

async function handlePdf(
	response: Response,
	url: string
): Promise<AgentToolResult> {
	const buffer = await response.arrayBuffer()
	const markdown = await pdf2md(buffer)
	const truncated = truncateText(markdown, MAX_OUTPUT_CHARS)

	return {
		content: [
			{
				type: 'text',
				text: truncated || '(no text extracted from PDF)'
			}
		],
		details: {
			url,
			contentType: 'application/pdf',
			charCount: markdown.length
		}
	}
}

function handleMedia(
	url: string,
	contentType: string,
	contentLength: string | null
): AgentToolResult {
	const size = contentLength
		? `\nSize: ${formatBytes(parseInt(contentLength, 10))}`
		: ''

	return {
		content: [
			{
				type: 'text',
				text: `Media resource: ${url}\nContent-Type: ${contentType}${size}`
			}
		],
		details: {
			url,
			contentType,
			contentLength: contentLength
				? parseInt(contentLength, 10)
				: null
		}
	}
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create the web fetch tool.
 */
export function createWebFetchTool(): AgentTool {
	return {
		name: 'fetch_page',
		description:
			'Fetch a web page, PDF, or other resource and extract its readable content as markdown. ' +
			'Automatically detects JavaScript-heavy pages and uses a headless browser when needed. ' +
			'Returns markdown for HTML pages and PDFs, or a URL reference for media files.',
		label: 'Fetching web page',
		parameters: webFetchParams,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as WebFetchParams

			try {
				const response = await fetch(params.url, {
					headers: { 'User-Agent': USER_AGENT },
					redirect: 'follow'
				})

				if (!response.ok) {
					return errorResult(
						`HTTP ${response.status} ${response.statusText}`
					)
				}

				const contentType =
					response.headers.get('content-type') ?? ''

				// PDF
				if (contentType.includes('application/pdf')) {
					return handlePdf(response, params.url)
				}

				// Media (image, video, audio)
				if (isMediaType(contentType)) {
					return handleMedia(
						params.url,
						contentType,
						response.headers.get('content-length')
					)
				}

				// HTML — auto-detects JS-heavy pages
				const html = await response.text()
				return handleHtml(html, params.url)
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : String(err)
				return errorResult(msg)
			}
		}
	}
}
