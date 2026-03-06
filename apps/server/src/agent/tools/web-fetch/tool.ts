/**
 * Web fetch tool — fetch and extract readable content from web pages,
 * PDFs, and other resources.
 *
 * Routes by Content-Type:
 *   Reddit    → JSON API → formatted text
 *   Wikipedia → extracts API → formatted text
 *   PDF       → fetch → pdf2md → markdown
 *   media     → fetch → URL reference
 *   HTML      → Puppeteer (via worker) → Defuddle → markdown
 */

import * as v from 'valibot'
import * as Comlink from 'comlink'
import pdf2md from '@opendocsg/pdf2md'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'
import type { FetchWorkerApi } from './defuddle.worker'
import {
	MAX_OUTPUT_CHARS,
	USER_AGENT,
	truncateText,
	errorResult,
	isMediaType,
	formatBytes
} from './common'
import { isRedditUrl, handleReddit } from './reddit'
import {
	isWikipediaUrl,
	handleWikipedia
} from './wikipedia'

// ── Schema ──────────────────────────────────────────────────────────────

const webFetchParams = v.object({
	url: v.pipe(
		v.string(),
		v.description('The URL of the web page to fetch')
	)
})

type WebFetchParams = v.InferOutput<typeof webFetchParams>

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

// Close browser in worker on exit — covers clean shutdowns
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

// Best-effort cleanup on crashes — the PID file will handle
// true orphans on next startup, but try to clean up here too.
process.on('beforeExit', () => {
	destroyWorker()
})

for (const event of [
	'uncaughtException',
	'unhandledRejection'
] as const) {
	process.on(event, () => {
		destroyWorker()
	})
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

				// Wikipedia — use REST API (no browser needed)
				if (isWikipediaUrl(params.url)) {
					return handleWikipedia(params.url)
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
