/**
 * Web fetch tool — fetch and extract readable content from web pages,
 * PDFs, and other resources.
 *
 * Routes by Content-Type:
 *   PDF   → fetch → pdf2md → markdown
 *   media → fetch → URL reference
 *   HTML  → Puppeteer (via worker) → Defuddle → markdown
 */

import * as v from 'valibot'
import * as Comlink from 'comlink'
import pdf2md from '@opendocsg/pdf2md'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import type { FetchWorkerApi } from './defuddle.worker'

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

// ── Fetch worker (lazy singleton) ───────────────────────────────────────

const WORKER_TIMEOUT = 5 * 60_000

let _worker: Worker | null = null
let _proxy: Comlink.Remote<FetchWorkerApi> | null = null

function destroyWorker() {
	const proxy = _proxy
	const worker = _worker
	_proxy = null
	_worker = null

	if (proxy) {
		try {
			proxy[Comlink.releaseProxy]()
		} catch {
			// Worker already dead — ignore
		}
	}
	if (worker) {
		worker.terminate()
	}
}

function getFetchWorker(): {
	proxy: Comlink.Remote<FetchWorkerApi>
	worker: Worker
} {
	if (!_proxy || !_worker) {
		destroyWorker()
		const w = new Worker(
			new URL('./defuddle.worker.ts', import.meta.url)
		)
		w.addEventListener('error', destroyWorker)
		_worker = w
		_proxy = Comlink.wrap<FetchWorkerApi>(w)
	}
	return { proxy: _proxy, worker: _worker }
}

/** Call a worker method with a timeout and worker-death detection. */
async function callWorker<T>(
	fn: (proxy: Comlink.Remote<FetchWorkerApi>) => Promise<T>
): Promise<T> {
	const { proxy, worker } = getFetchWorker()

	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			destroyWorker()
			reject(new Error('Worker timed out'))
		}, WORKER_TIMEOUT)

		const onError = () => {
			clearTimeout(timer)
			reject(new Error('Worker terminated unexpectedly'))
		}
		worker.addEventListener('error', onError, {
			once: true
		})

		fn(proxy)
			.then(resolve)
			.catch(reject)
			.finally(() => {
				clearTimeout(timer)
				worker.removeEventListener('error', onError)
			})
	})
}

// Close browser in worker on exit
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		if (_proxy) {
			const close = _proxy.close()
			const timeout = setTimeout(
				() => process.exit(0),
				3_000
			)
			close.finally(() => {
				clearTimeout(timeout)
				process.exit(0)
			})
		} else {
			process.exit(0)
		}
	})
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

// ── Reddit handler ───────────────────────────────────────────────────────

const REDDIT_HOST_RE = /^(?:www\.)?(?:old\.)?reddit\.com$/

function isRedditUrl(url: string): boolean {
	try {
		return REDDIT_HOST_RE.test(new URL(url).hostname)
	} catch {
		return false
	}
}

/** Convert a Reddit URL to its JSON API equivalent. */
function toRedditJsonUrl(url: string): string {
	const u = new URL(url)
	// Strip trailing slash, append .json
	u.pathname = u.pathname.replace(/\/+$/, '') + '.json'
	// Carry over query params (e.g. ?t=day)
	return u.toString()
}

interface RedditPost {
	title: string
	score: number
	author: string
	url: string
	permalink: string
	selftext: string
	num_comments: number
	subreddit: string
	created_utc: number
}

interface RedditComment {
	author: string
	body: string
	score: number
	depth: number
	replies?: { data?: { children?: RedditCommentChild[] } }
}

interface RedditCommentChild {
	kind: string
	data: RedditComment
}

function compactNumber(n: number): string {
	if (n >= 1_000_000)
		return (n / 1_000_000).toFixed(1) + 'M'
	if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
	return String(n)
}

function formatRedditListing(
	posts: RedditPost[],
	subreddit: string
): string {
	const lines: string[] = [`r/${subreddit}\n`]
	for (let i = 0; i < posts.length; i++) {
		const p = posts[i]
		lines.push(
			`${i + 1}. ${p.title} [↑${compactNumber(p.score)} · ${compactNumber(p.num_comments)}c · u/${p.author}]`
		)
	}
	return lines.join('\n')
}

function formatRedditThread(
	post: RedditPost,
	comments: RedditComment[]
): string {
	const lines: string[] = [
		post.title,
		`↑${compactNumber(post.score)} · ${compactNumber(post.num_comments)}c · u/${post.author}`
	]
	if (post.url && !post.url.includes('reddit.com'))
		lines.push(post.url)
	if (post.selftext) lines.push('', post.selftext)

	if (comments.length) {
		lines.push('', '---')
		for (const c of comments) {
			const indent = '> '.repeat(c.depth)
			lines.push(
				`${indent}u/${c.author} [↑${compactNumber(c.score)}]: ${c.body.replaceAll('\n', '\n' + indent)}`
			)
		}
	}
	return lines.join('\n')
}

/** Flatten comment tree to a list, depth-first. */
function flattenComments(
	children: RedditCommentChild[],
	depth = 0,
	max = 30
): RedditComment[] {
	const out: RedditComment[] = []
	for (const child of children) {
		if (out.length >= max) break
		if (child.kind !== 't1') continue
		const c = child.data
		out.push({
			author: c.author,
			body: c.body,
			score: c.score,
			depth
		})
		if (c.replies?.data?.children) {
			out.push(
				...flattenComments(
					c.replies.data.children,
					depth + 1,
					max - out.length
				)
			)
		}
	}
	return out
}

async function handleReddit(
	url: string
): Promise<AgentToolResult> {
	const jsonUrl = toRedditJsonUrl(url)
	const res = await fetch(jsonUrl, {
		headers: { 'User-Agent': USER_AGENT }
	})
	if (!res.ok) {
		return errorResult(
			`Reddit API: HTTP ${res.status} ${res.statusText}`
		)
	}
	const data = await res.json()

	// Listing page (subreddit feed, search, etc.)
	if (!Array.isArray(data)) {
		const listing = data?.data?.children ?? []
		const posts: RedditPost[] = listing.map(
			(c: { data: RedditPost }) => c.data
		)
		const sub =
			posts[0]?.subreddit ??
			url.match(/\/r\/(\w+)/)?.[1] ??
			'reddit'

		const text = formatRedditListing(posts, sub)
		const truncated = truncateText(text, MAX_OUTPUT_CHARS)

		return {
			content: [{ type: 'text', text: truncated }],
			details: {
				url,
				source: 'reddit-json',
				postCount: posts.length
			}
		}
	}

	// Thread page — array of [post listing, comments listing]
	const postData = data[0]?.data?.children?.[0]?.data as
		| RedditPost
		| undefined
	if (!postData)
		return errorResult('Reddit: could not parse thread')

	const commentChildren: RedditCommentChild[] =
		data[1]?.data?.children ?? []
	const comments = flattenComments(commentChildren)

	const text = formatRedditThread(postData, comments)
	const truncated = truncateText(text, MAX_OUTPUT_CHARS)

	return {
		content: [{ type: 'text', text: truncated }],
		details: {
			url,
			source: 'reddit-json',
			title: postData.title,
			author: postData.author,
			commentCount: comments.length
		}
	}
}

// ── Handlers ────────────────────────────────────────────────────────────

async function handleBrowser(
	url: string
): Promise<AgentToolResult> {
	const result = await callWorker(w => w.fetchPage(url))

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
