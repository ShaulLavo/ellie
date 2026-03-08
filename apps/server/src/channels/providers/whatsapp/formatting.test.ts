import { describe, expect, test } from 'bun:test'
import {
	markdownToWhatsApp,
	chunkMessage
} from './formatting'

describe('markdownToWhatsApp', () => {
	test('converts **bold** to *bold*', () => {
		expect(markdownToWhatsApp('**hello**')).toBe(
			'*hello*'
		)
	})

	test('converts __bold__ to *bold*', () => {
		expect(markdownToWhatsApp('__hello__')).toBe(
			'*hello*'
		)
	})

	test('preserves _italic_ as-is', () => {
		expect(markdownToWhatsApp('_hello_')).toBe(
			'_hello_'
		)
	})

	test('converts ~~strikethrough~~ to ~strikethrough~', () => {
		expect(markdownToWhatsApp('~~hello~~')).toBe(
			'~hello~'
		)
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
			markdownToWhatsApp('[click here](https://example.com)')
		).toBe('click here (https://example.com)')
	})

	test('converts # headers to *bold*', () => {
		expect(markdownToWhatsApp('# Title')).toBe(
			'*Title*'
		)
		expect(markdownToWhatsApp('### Sub')).toBe(
			'*Sub*'
		)
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
		expect(chunkMessage('hello', 100)).toEqual([
			'hello'
		])
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

	test('handles single line exceeding max', () => {
		const long = 'a'.repeat(200)
		const chunks = chunkMessage(long, 100)
		// Single line can't be split, gets its own chunk
		expect(chunks).toHaveLength(1)
		expect(chunks[0]).toBe(long)
	})

	test('uses default 4000 max length', () => {
		const text = 'a'.repeat(3999)
		expect(chunkMessage(text)).toHaveLength(1)
	})
})
