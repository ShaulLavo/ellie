import type { AgentToolResult } from '@ellie/agent'
import {
	MAX_OUTPUT_CHARS,
	USER_AGENT,
	truncateText,
	errorResult
} from './common'

const WIKIPEDIA_HOST_RE =
	/^(?:\w+\.)?(?:\w+\.)?wikipedia\.org$/

export function isWikipediaUrl(url: string): boolean {
	try {
		const u = new URL(url)
		return (
			WIKIPEDIA_HOST_RE.test(u.hostname) &&
			u.pathname.startsWith('/wiki/')
		)
	} catch {
		return false
	}
}

/** Build the MediaWiki extracts API URL for a Wikipedia page. */
function toWikipediaExtractsUrl(url: string): {
	apiUrl: string
	title: string
} {
	const u = new URL(url)
	// Normalize mobile URLs: en.m.wikipedia.org → en.wikipedia.org
	const host = u.hostname.replace(
		'.m.wikipedia',
		'.wikipedia'
	)
	const title = decodeURIComponent(
		u.pathname.replace(/^\/wiki\//, '')
	)
	const apiUrl =
		`https://${host}/w/api.php?` +
		new URLSearchParams({
			action: 'query',
			titles: title,
			prop: 'extracts',
			explaintext: 'true',
			redirects: 'true',
			format: 'json'
		}).toString()
	return { apiUrl, title }
}

/** Convert MediaWiki `== Heading ==` syntax to markdown `## Heading`. */
function wikiExtractToMarkdown(
	title: string,
	extract: string
): string {
	const md = extract
		// === Sub-subsection === → ### Sub-subsection
		.replace(/^===\s*(.+?)\s*===$/gm, '### $1')
		// == Subsection == → ## Subsection
		.replace(/^==\s*(.+?)\s*==$/gm, '## $1')
		// Collapse 3+ blank lines to 2
		.replace(/\n{3,}/g, '\n\n')

	return `# ${title}\n\n${md}`.trim()
}

/** Sections to strip from the end of a Wikipedia article. */
const WIKI_STRIP_SECTIONS =
	/^#{2,3} (References|See also|External links|Further reading|Notes|Citations|Sources)$/im

export async function handleWikipedia(
	url: string
): Promise<AgentToolResult> {
	const { apiUrl, title: fallbackTitle } =
		toWikipediaExtractsUrl(url)
	const res = await fetch(apiUrl, {
		headers: { 'User-Agent': USER_AGENT }
	})
	if (!res.ok) {
		return errorResult(
			`Wikipedia API: HTTP ${res.status} ${res.statusText}`
		)
	}

	const data = await res.json()
	const pages = data?.query?.pages
	if (!pages)
		return errorResult('Wikipedia: unexpected API response')

	const page = Object.values(pages)[0] as {
		title?: string
		extract?: string
		missing?: string
	}
	if (page.missing !== undefined) {
		return errorResult(`Wikipedia: page not found`)
	}

	const title = page.title ?? fallbackTitle
	const extract = page.extract ?? ''

	let markdown = wikiExtractToMarkdown(title, extract)

	// Strip trailing boilerplate sections
	const stripIdx = markdown.search(WIKI_STRIP_SECTIONS)
	if (stripIdx !== -1) {
		markdown = markdown.slice(0, stripIdx).trim()
	}

	const truncated = truncateText(markdown, MAX_OUTPUT_CHARS)

	return {
		content: [
			{
				type: 'text',
				text: truncated || '(no readable content found)'
			}
		],
		details: {
			url,
			source: 'wikipedia-rest',
			title
		}
	}
}
