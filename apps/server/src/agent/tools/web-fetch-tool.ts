/**
 * Web fetch tool — fetch and extract readable content from web pages.
 *
 * Uses JSDOM to fetch the page and Defuddle to extract clean,
 * readable content (optionally as markdown).
 */

import * as v from 'valibot'
import { JSDOM } from 'jsdom'
import { Defuddle } from 'defuddle/node'
import type {
	AgentTool,
	AgentToolResult
} from '@ellie/agent'

// ── Schema ──────────────────────────────────────────────────────────────

const webFetchParams = v.object({
	url: v.pipe(
		v.string(),
		v.description('The URL of the web page to fetch')
	),
	markdown: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Convert content to markdown (default: true)'
			)
		)
	)
})

type WebFetchParams = v.InferOutput<typeof webFetchParams>

// ── Constants ───────────────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 50_000

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create the web fetch tool.
 */
export function createWebFetchTool(): AgentTool {
	return {
		name: 'web_fetch',
		description:
			'Fetch a web page and extract its readable content. Returns the page title, author, and main content (as markdown by default). Use this to read articles, documentation, or any web page.',
		label: 'Fetching web page',
		parameters: webFetchParams,
		execute: async (
			_toolCallId,
			rawParams
		): Promise<AgentToolResult> => {
			const params = rawParams as WebFetchParams
			const markdown = params.markdown ?? true

			try {
				const response = await fetch(params.url)
				const html = await response.text()
				const dom = new JSDOM(html, { url: params.url })
				const result = await Defuddle(dom, params.url, {
					markdown
				})

				const parts: string[] = []
				if (result.title) parts.push(`# ${result.title}`)
				if (result.author)
					parts.push(`**Author:** ${result.author}`)
				if (result.content) parts.push(result.content)

				const text = parts.join('\n\n')
				const truncated =
					text.length > MAX_OUTPUT_CHARS
						? text.slice(0, MAX_OUTPUT_CHARS) +
							`\n... (truncated at ${MAX_OUTPUT_CHARS} chars)`
						: text

				return {
					content: [
						{
							type: 'text',
							text:
								truncated || '(no readable content found)'
						}
					],
					details: {
						url: params.url,
						title: result.title ?? null,
						author: result.author ?? null,
						wordCount: result.wordCount ?? 0
					}
				}
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : String(err)
				return {
					content: [
						{
							type: 'text',
							text: `Web fetch error: ${msg}`
						}
					],
					details: { success: false, error: msg }
				}
			}
		}
	}
}
