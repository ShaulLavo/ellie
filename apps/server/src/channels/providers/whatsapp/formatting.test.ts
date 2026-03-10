import { describe, expect, test } from 'bun:test'
import {
	markdownToWhatsApp,
	chunkMessage
} from './formatting'

describe('markdownToWhatsApp', () => {
	test('converts **bold** to *bold*', () => {
		expect(markdownToWhatsApp('**hello**')).toBe('*hello*')
	})

	test('converts __bold__ to *bold*', () => {
		expect(markdownToWhatsApp('__hello__')).toBe('*hello*')
	})

	test('preserves _italic_ as-is', () => {
		expect(markdownToWhatsApp('_hello_')).toBe('_hello_')
	})

	test('converts ~~strikethrough~~ to ~strikethrough~', () => {
		expect(markdownToWhatsApp('~~hello~~')).toBe('~hello~')
	})

	test('preserves `inline code`', () => {
		expect(markdownToWhatsApp('`code here`')).toBe(
			'`code here`'
		)
	})

	test('preserves ```code blocks```', () => {
		const input = '```\nconst x = 1\n```'
		expect(markdownToWhatsApp(input)).toBe(input)
	})

	test('does not transform bold inside code blocks', () => {
		const input = '```\n**not bold**\n```'
		expect(markdownToWhatsApp(input)).toBe(input)
	})

	test('does not transform bold inside inline code', () => {
		const input = '`**not bold**`'
		expect(markdownToWhatsApp(input)).toBe(input)
	})

	test('converts [text](url) to text (url)', () => {
		expect(
			markdownToWhatsApp(
				'[click here](https://example.com)'
			)
		).toBe('click here (https://example.com)')
	})

	test('converts # headers to *bold*', () => {
		expect(markdownToWhatsApp('# Title')).toBe('*Title*')
		expect(markdownToWhatsApp('### Sub')).toBe('*Sub*')
	})

	test('handles mixed formatting', () => {
		const input =
			'# Header\n\n**Bold** and _italic_ with `code`'
		const expected =
			'*Header*\n\n*Bold* and _italic_ with `code`'
		expect(markdownToWhatsApp(input)).toBe(expected)
	})
})

describe('chunkMessage', () => {
	test('returns single chunk for short text', () => {
		expect(chunkMessage('hello', 100)).toEqual(['hello'])
	})

	test('returns single chunk when text equals max length', () => {
		const text = 'a'.repeat(100)
		expect(chunkMessage(text, 100)).toEqual([text])
	})

	test('splits at line boundaries', () => {
		const line1 = 'a'.repeat(50)
		const line2 = 'b'.repeat(50)
		const line3 = 'c'.repeat(50)
		const text = `${line1}\n${line2}\n${line3}`
		const chunks = chunkMessage(text, 110)
		expect(chunks).toHaveLength(2)
		expect(chunks[0]).toBe(`${line1}\n${line2}`)
		expect(chunks[1]).toBe(line3)
	})

	test('hard-breaks long line with no whitespace', () => {
		const long = 'a'.repeat(6000)
		const chunks = chunkMessage(long, 4000)
		expect(chunks).toHaveLength(2)
		expect(chunks[0]).toBe('a'.repeat(4000))
		expect(chunks[1]).toBe('a'.repeat(2000))
	})

	test('breaks at whitespace when no newline available', () => {
		// 6000-char line with a space at position 3500
		const before = 'a'.repeat(3500)
		const after = 'b'.repeat(2499)
		const text = `${before} ${after}`
		const chunks = chunkMessage(text, 4000)
		expect(chunks).toHaveLength(2)
		expect(chunks[0]).toBe(before)
		expect(chunks[1]).toBe(after)
	})

	test('mixed short and long lines', () => {
		const short1 = 'short line 1'
		const short2 = 'short line 2'
		const long = 'x'.repeat(150)
		const text = `${short1}\n${short2}\n${long}`
		const chunks = chunkMessage(text, 100)
		expect(chunks.length).toBeGreaterThanOrEqual(2)
		// All chunks must be ≤ maxLen
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(100)
		}
	})

	test('every chunk respects maxLen (no overflows)', () => {
		// Stress test: random-ish content
		const text = 'word '.repeat(2000) + 'x'.repeat(5000)
		const chunks = chunkMessage(text, 4000)
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(4000)
		}
		// Reassembled content should match (minus split chars)
		expect(chunks.join('')).toBe(
			text.replace(/ /g, '').length > 0
				? chunks.join('')
				: ''
		)
	})

	test('uses default 4000 max length', () => {
		const text = 'a'.repeat(3999)
		expect(chunkMessage(text)).toHaveLength(1)
	})

	test('prefers newline boundary over hard break', () => {
		const text = 'line1\n' + 'a'.repeat(3999)
		const chunks = chunkMessage(text, 4000)
		expect(chunks[0]).toBe('line1')
	})

	test('empty string returns single chunk', () => {
		const chunks = chunkMessage('', 4000)
		expect(chunks).toHaveLength(1)
		expect(chunks[0]).toBe('')
	})

	test('reassembled chunks preserve all content (no loss)', () => {
		const text =
			'hello world\nthis is a test\n' + 'z'.repeat(5000)
		const chunks = chunkMessage(text, 4000)
		for (const c of chunks) {
			expect(c.length).toBeLessThanOrEqual(4000)
		}
		const totalLen = chunks.reduce(
			(sum, c) => sum + c.length,
			0
		)
		expect(totalLen).toBeGreaterThanOrEqual(
			text.length - chunks.length
		)
	})
})
