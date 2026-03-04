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

	test('returns html when markdown is false', async () => {
		const result = await tool.execute('tc-1', {
			url: 'https://en.wikipedia.org/wiki/Bun_(software)',
			markdown: false
		})

		const text = textOf(result)
		expect(text).toMatch(/<[a-z]/)
	}, 15_000)

	test('handles invalid URL gracefully', async () => {
		const result = await tool.execute('tc-1', {
			url: 'https://this-domain-definitely-does-not-exist-12345.com'
		})

		const text = textOf(result)
		expect(text).toStartWith('Web fetch error:')
		expect(result.details).toHaveProperty('success', false)
	}, 15_000)
})
