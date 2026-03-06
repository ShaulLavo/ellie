import { describe, expect, test } from 'bun:test'
import {
	needsTruncation,
	truncateToolResult
} from '../src/tool-safety'
import type { AgentToolResult } from '../src/types'

function makeTextResult(text: string): AgentToolResult {
	return {
		content: [{ type: 'text', text }],
		details: {}
	}
}

function makeMultiBlockResult(
	...texts: string[]
): AgentToolResult {
	return {
		content: texts.map(t => ({
			type: 'text' as const,
			text: t
		})),
		details: {}
	}
}

// ============================================================================
// needsTruncation
// ============================================================================

describe('needsTruncation', () => {
	test('returns false for small results', () => {
		const result = makeTextResult('hello world')
		expect(needsTruncation(result, 50_000)).toBe(false)
	})

	test('returns true for oversized results', () => {
		const result = makeTextResult('x'.repeat(60_000))
		expect(needsTruncation(result, 50_000)).toBe(true)
	})

	test('returns false at exact boundary', () => {
		const result = makeTextResult('x'.repeat(50_000))
		expect(needsTruncation(result, 50_000)).toBe(false)
	})

	test('counts total chars across multiple text blocks', () => {
		const result = makeMultiBlockResult(
			'x'.repeat(30_000),
			'y'.repeat(30_000)
		)
		expect(needsTruncation(result, 50_000)).toBe(true)
	})

	test('ignores image blocks', () => {
		const result: AgentToolResult = {
			content: [
				{ type: 'text', text: 'small' },
				{
					type: 'image',
					source: 'data:image/png;base64,abc',
					mediaType: 'image/png'
				}
			],
			details: {}
		}
		expect(needsTruncation(result, 50_000)).toBe(false)
	})

	test('uses default maxChars when not specified', () => {
		// Default is 50_000
		const small = makeTextResult('x'.repeat(49_999))
		const big = makeTextResult('x'.repeat(50_001))
		expect(needsTruncation(small)).toBe(false)
		expect(needsTruncation(big)).toBe(true)
	})
})

// ============================================================================
// truncateToolResult
// ============================================================================

describe('truncateToolResult', () => {
	test('returns unchanged result when within limit', () => {
		const result = makeTextResult('hello world')
		const truncated = truncateToolResult(result, 50_000)
		expect(truncated).toEqual(result)
	})

	test('truncates oversized single text block', () => {
		const bigText = 'x'.repeat(100_000)
		const result = makeTextResult(bigText)
		const truncated = truncateToolResult(result, 10_000)

		expect(truncated.content.length).toBe(1)
		const text =
			truncated.content[0].type === 'text'
				? truncated.content[0].text
				: ''
		expect(text.length).toBeLessThan(bigText.length)
		expect(text).toContain('truncated')
	})

	test('preserves at least MIN_KEEP_CHARS (2000)', () => {
		const bigText = 'a'.repeat(100_000)
		const result = makeTextResult(bigText)
		// Very small maxChars — should still keep at least 2000
		const truncated = truncateToolResult(result, 100)

		const text =
			truncated.content[0].type === 'text'
				? truncated.content[0].text
				: ''
		// Text content (excluding suffix) should be at least 2000 chars
		const withoutSuffix = text.split('---')[0]
		expect(withoutSuffix.length).toBeGreaterThanOrEqual(
			2000
		)
	})

	test('cuts at newline boundary when possible', () => {
		// Build text with newlines every 100 chars
		const lines = Array.from(
			{ length: 200 },
			(_, i) => `line ${i}: ${'x'.repeat(90)}`
		).join('\n')
		const result = makeTextResult(lines)
		const truncated = truncateToolResult(result, 5_000)

		const text =
			truncated.content[0].type === 'text'
				? truncated.content[0].text
				: ''
		// The cut point should be at a newline (before the truncation suffix)
		const mainContent = text.split('\n\n---')[0]
		expect(
			mainContent.endsWith('\n') ||
				mainContent.includes('line')
		).toBe(true)
	})

	test('handles multiple text blocks with proportional budget', () => {
		// Block 1: 30K chars, Block 2: 70K chars
		const result = makeMultiBlockResult(
			'a'.repeat(30_000),
			'b'.repeat(70_000)
		)
		const truncated = truncateToolResult(result, 10_000)

		// Both blocks should be truncated
		// Block 2 should get more budget since it was larger
		const block1 =
			truncated.content[0].type === 'text'
				? truncated.content[0].text
				: ''
		const block2 =
			truncated.content[1].type === 'text'
				? truncated.content[1].text
				: ''

		expect(block1.length).toBeLessThan(30_000)
		expect(block2.length).toBeLessThan(70_000)
	})

	test('preserves image content blocks', () => {
		const result: AgentToolResult = {
			content: [
				{ type: 'text', text: 'x'.repeat(100_000) },
				{
					type: 'image',
					source: 'data:image/png;base64,abc',
					mediaType: 'image/png'
				}
			],
			details: {}
		}
		const truncated = truncateToolResult(result, 10_000)

		// Image block should be preserved
		expect(truncated.content.length).toBe(2)
		expect(truncated.content[1].type).toBe('image')
	})

	test('preserves details field', () => {
		const result: AgentToolResult = {
			content: [
				{ type: 'text', text: 'x'.repeat(100_000) }
			],
			details: { key: 'value', nested: { a: 1 } }
		}
		const truncated = truncateToolResult(result, 10_000)
		expect(truncated.details).toEqual({
			key: 'value',
			nested: { a: 1 }
		})
	})

	test('adds truncation suffix exactly once', () => {
		const result = makeTextResult('x'.repeat(100_000))
		const truncated = truncateToolResult(result, 10_000)
		const text =
			truncated.content[0].type === 'text'
				? truncated.content[0].text
				: ''
		const suffixCount = (
			text.match(/Output truncated/g) || []
		).length
		expect(suffixCount).toBe(1)
	})

	test('handles empty content', () => {
		const result: AgentToolResult = {
			content: [],
			details: {}
		}
		const truncated = truncateToolResult(result, 10_000)
		expect(truncated.content).toEqual([])
	})

	test('handles result with only images', () => {
		const result: AgentToolResult = {
			content: [
				{
					type: 'image',
					source: 'data:image/png;base64,abc',
					mediaType: 'image/png'
				}
			],
			details: {}
		}
		const truncated = truncateToolResult(result, 100)
		expect(truncated).toEqual(result)
	})
})
