import { describe, expect, test } from 'bun:test'
import type { AgentToolResult } from '@ellie/agent'
import { createWebFetchTool } from './tool'

function textOf(result: AgentToolResult): string {
	const block = result.content[0]
	if (block.type !== 'text')
		throw new Error('Expected text content')
	return block.text
}

describe('web_fetch tool', () => {
	const tool = createWebFetchTool()

	test('fetches a Wikipedia page via extracts API', async () => {
		const result = await tool.execute('tc-wiki', {
			url: 'https://en.wikipedia.org/wiki/TypeScript'
		})

		const text = textOf(result)
		expect(text).toContain('TypeScript')
		expect(text.length).toBeGreaterThan(500)

		const details = result.details as {
			url: string
			source: string
			title: string
		}
		expect(details.url).toBe(
			'https://en.wikipedia.org/wiki/TypeScript'
		)
		expect(details.source).toBe('wikipedia-rest')
		expect(details.title).toContain('TypeScript')
	}, 15_000)

	test('Wikipedia: returns markdown headings, no raw HTML', async () => {
		const result = await tool.execute('tc-wiki-md', {
			url: 'https://en.wikipedia.org/wiki/Bun_(software)'
		})

		const text = textOf(result)
		expect(text).toMatch(/^# /m)
		expect(text).toMatch(/^## /m)
		expect(text).not.toMatch(/<[a-z]/)
	}, 15_000)

	test('Wikipedia: strips References and See also sections', async () => {
		const result = await tool.execute('tc-wiki-strip', {
			url: 'https://en.wikipedia.org/wiki/TypeScript'
		})

		const text = textOf(result)
		expect(text).not.toMatch(/^## References$/m)
		expect(text).not.toMatch(/^## See also$/m)
		expect(text).not.toMatch(/^## External links$/m)
	}, 15_000)

	test('Wikipedia: handles non-English wikis', async () => {
		const result = await tool.execute('tc-wiki-lang', {
			url: 'https://fr.wikipedia.org/wiki/TypeScript'
		})

		const text = textOf(result)
		expect(text).toContain('TypeScript')
		expect(text.length).toBeGreaterThan(200)

		const details = result.details as { source: string }
		expect(details.source).toBe('wikipedia-rest')
	}, 15_000)

	test('Wikipedia: handles mobile URLs (en.m.wikipedia.org)', async () => {
		const result = await tool.execute('tc-wiki-mobile', {
			url: 'https://en.m.wikipedia.org/wiki/TypeScript'
		})

		const text = textOf(result)
		expect(text).toContain('TypeScript')
		expect(text.length).toBeGreaterThan(500)

		const details = result.details as { source: string }
		expect(details.source).toBe('wikipedia-rest')
	}, 15_000)

	test('Reddit: fetches subreddit listing', async () => {
		const result = await tool.execute('tc-reddit-sub', {
			url: 'https://www.reddit.com/r/typescript'
		})

		const text = textOf(result)
		expect(text).toContain('r/typescript')
		expect(text).toMatch(/^\d+\./m)

		const details = result.details as {
			source: string
			postCount: number
		}
		expect(details.source).toBe('reddit-json')
		expect(details.postCount).toBeGreaterThan(0)
	}, 15_000)

	test('Reddit: fetches thread with comments', async () => {
		const result = await tool.execute('tc-reddit-thread', {
			url: 'https://www.reddit.com/r/typescript/comments/1hhvut3/i_thought_i_was_a_coding_genius_then_i_met/'
		})

		const text = textOf(result)
		expect(text).toMatch(/u\//)
		expect(text).toContain('---')

		const details = result.details as {
			source: string
			title: string
			commentCount: number
		}
		expect(details.source).toBe('reddit-json')
		expect(details.title).toBeTruthy()
		expect(details.commentCount).toBeGreaterThan(0)
	}, 15_000)

	test('Reddit: handles old.reddit URLs', async () => {
		const result = await tool.execute('tc-reddit-old', {
			url: 'https://old.reddit.com/r/typescript'
		})

		const text = textOf(result)
		expect(text).toContain('r/typescript')

		const details = result.details as { source: string }
		expect(details.source).toBe('reddit-json')
	}, 15_000)

	test('renders SPA pages via headless browser', async () => {
		const result = await tool.execute('tc-spa', {
			url: 'https://react.dev/learn'
		})

		const text = textOf(result)
		expect(text.length).toBeGreaterThan(200)
	}, 30_000)

	test('handles invalid URL gracefully', async () => {
		const result = await tool.execute('tc-1', {
			url: 'https://this-domain-definitely-does-not-exist-12345.com'
		})

		const text = textOf(result)
		expect(text).toStartWith('Web fetch error:')
		expect(result.details).toHaveProperty('success', false)
	}, 15_000)

	test('extracts markdown from a PDF', async () => {
		const result = await tool.execute('tc-pdf', {
			url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf'
		})

		const text = textOf(result)
		expect(text).not.toStartWith('Web fetch error:')
		expect(text.length).toBeGreaterThan(10)

		const details = result.details as {
			contentType: string
		}
		expect(details.contentType).toBe('application/pdf')
	}, 15_000)

	test('returns URL reference for image content', async () => {
		const result = await tool.execute('tc-media', {
			url: 'https://www.w3.org/Icons/w3c_home.png'
		})

		const text = textOf(result)
		expect(text).toContain('Media resource:')
		expect(text).toContain('image/png')

		const details = result.details as {
			url: string
			contentType: string
		}
		expect(details.contentType).toContain('image/png')
	}, 15_000)

	test('handles non-OK HTTP responses', async () => {
		const result = await tool.execute('tc-404', {
			url: 'https://www.google.com/this-page-does-not-exist-12345'
		})

		const text = textOf(result)
		expect(text).toContain('Web fetch error:')
		expect(text).toContain('404')
	}, 15_000)

	test('handles missing Wikipedia page', async () => {
		const result = await tool.execute('tc-wiki-404', {
			url: 'https://en.wikipedia.org/wiki/This_page_definitely_does_not_exist_12345'
		})

		const text = textOf(result)
		expect(text).toContain('Web fetch error:')
		expect(text).toContain('page not found')
	}, 15_000)
})
