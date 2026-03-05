import { describe, expect, test } from 'bun:test'
import type { AgentToolResult } from '@ellie/agent'
import { createWebFetchTool } from './web-fetch-tool'

function textOf(result: AgentToolResult): string {
	const block = result.content[0]
	if (block.type !== 'text')
		throw new Error('Expected text content')
	return block.text
}

describe('web_fetch tool', () => {
	const tool = createWebFetchTool()

	// ── HTML (static) ───────────────────────────────────────────────

	test('fetches a Wikipedia page and extracts content', async () => {
		const result = await tool.execute('tc-1', {
			url: 'https://en.wikipedia.org/wiki/TypeScript'
		})

		const text = textOf(result)
		expect(text).toContain('TypeScript')
		expect(text.length).toBeGreaterThan(500)

		const details = result.details as {
			url: string
			title: string | null
			wordCount: number
		}
		expect(details.url).toBe(
			'https://en.wikipedia.org/wiki/TypeScript'
		)
		expect(details.title).toContain('TypeScript')
		expect(details.wordCount).toBeGreaterThan(100)
	}, 15_000)

	test('returns markdown by default', async () => {
		const result = await tool.execute('tc-1', {
			url: 'https://en.wikipedia.org/wiki/Bun_(software)'
		})

		const text = textOf(result)
		// Markdown should have headers
		expect(text).toContain('#')
	}, 15_000)

	test('uses atx headings and no raw html tags', async () => {
		const result = await tool.execute('tc-1', {
			url: 'https://en.wikipedia.org/wiki/Bun_(software)'
		})

		const text = textOf(result)
		// Turndown atx headings (## style), not raw HTML
		expect(text).toMatch(/^#{1,6} /m)
		expect(text).not.toMatch(/<[a-z]/)
	}, 15_000)

	test('handles invalid URL gracefully', async () => {
		const result = await tool.execute('tc-1', {
			url: 'https://this-domain-definitely-does-not-exist-12345.com'
		})

		const text = textOf(result)
		expect(text).toStartWith('Web fetch error:')
		expect(result.details).toHaveProperty('success', false)
	}, 15_000)

	// ── PDF ──────────────────────────────────────────────────────────

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

	// ── Media ────────────────────────────────────────────────────────

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

	// ── HTTP errors ──────────────────────────────────────────────────

	test('handles non-OK HTTP responses', async () => {
		const result = await tool.execute('tc-404', {
			url: 'https://en.wikipedia.org/wiki/This_page_definitely_does_not_exist_12345'
		})

		const text = textOf(result)
		expect(text).toContain('Web fetch error:')
		expect(text).toContain('404')
	}, 15_000)

	// ── Auto Playwright (SPA detection) ─────────────────────────────

	test('auto-detects SPA and falls back to Playwright', async () => {
		// react.dev is a known SPA — static fetch yields a shell
		const result = await tool.execute('tc-spa', {
			url: 'https://react.dev/learn'
		})

		const text = textOf(result)
		// Should still extract meaningful content via Playwright
		expect(text.length).toBeGreaterThan(200)
	}, 30_000)
})
