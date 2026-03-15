import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach,
	mock
} from 'bun:test'
import {
	stripMarkdownForTts,
	truncateForTts,
	synthesizeToPayload
} from './reply-tts'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, existsSync } from 'fs'

describe('stripMarkdownForTts', () => {
	test('removes bold markers', () => {
		expect(stripMarkdownForTts('**bold** text')).toBe(
			'bold text'
		)
	})

	test('removes italic markers', () => {
		expect(stripMarkdownForTts('*italic* text')).toBe(
			'italic text'
		)
	})

	test('removes inline code markers but keeps content', () => {
		expect(stripMarkdownForTts('`code` here')).toBe(
			'code here'
		)
	})

	test('converts links to just text', () => {
		expect(
			stripMarkdownForTts('[link text](https://url)')
		).toBe('link text')
	})

	test('removes header markers but keeps text', () => {
		expect(stripMarkdownForTts('# Header\nBody')).toBe(
			'Header\nBody'
		)
	})

	test('removes code blocks entirely', () => {
		expect(stripMarkdownForTts('```js\ncode\n```')).toBe('')
	})

	test('preserves normal text', () => {
		expect(stripMarkdownForTts('Normal text')).toBe(
			'Normal text'
		)
	})

	test('removes horizontal rules', () => {
		expect(stripMarkdownForTts('Above\n---\nBelow')).toBe(
			'Above\n\nBelow'
		)
	})

	test('removes HTML tags', () => {
		expect(stripMarkdownForTts('Hello <b>world</b>')).toBe(
			'Hello world'
		)
	})

	test('handles combined markdown', () => {
		const input =
			'# Title\n**Bold** and *italic* with [link](url)\n```\ncode\n```'
		const result = stripMarkdownForTts(input)
		expect(result).toBe('Title\nBold and italic with link')
	})

	test('removes underscore bold/italic', () => {
		expect(stripMarkdownForTts('__bold__ text')).toBe(
			'bold text'
		)
	})
})

describe('truncateForTts', () => {
	test('returns short text unchanged', () => {
		expect(truncateForTts('Short.', 1500)).toBe('Short.')
	})

	test('truncates at sentence boundary', () => {
		const input =
			'First sentence. Second sentence. Third is very long and keeps going.'
		const result = truncateForTts(input, 35)
		expect(result).toBe(
			'First sentence. Second sentence....'
		)
	})

	test('truncates long text with ellipsis', () => {
		const longText = 'A'.repeat(2000)
		const result = truncateForTts(longText, 1500)
		expect(result.length).toBeLessThanOrEqual(1504) // 1500 + '...'
		expect(result.endsWith('...')).toBe(true)
	})

	test('truncates at word boundary when no sentence end', () => {
		const input = 'word1 word2 word3 word4 word5'
		const result = truncateForTts(input, 15)
		expect(result).toBe('word1 word2...')
	})

	test('uses default maxChars of 1500', () => {
		const shortText = 'Hello world.'
		expect(truncateForTts(shortText)).toBe(shortText)
	})
})

describe('synthesizeToPayload', () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'reply-tts-test-'))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	// Mock elevenLabsTTS at the module level
	const mockTTS = mock(() =>
		Promise.resolve({
			audio: Buffer.from('fake-audio-data'),
			outputFormat: 'mp3_44100_128',
			mime: 'audio/mpeg',
			extension: 'mp3',
			voiceCompatible: false,
			provider: 'elevenlabs' as const
		})
	)

	// We need to mock the module import
	mock.module('../../lib/tts', () => ({
		elevenLabsTTS: mockTTS
	}))

	test('returns payload with mediaRef', async () => {
		const payload = await synthesizeToPayload(
			'Hello world',
			{ tmpDir: dir }
		)

		expect(payload.mediaRefs).toBeDefined()
		expect(payload.mediaRefs!.length).toBe(1)
		expect(payload.mediaRefs![0]).toContain('ellie-tts-')
		expect(payload.mediaRefs![0]).toEndWith('.mp3')
	})

	test('sets audioAsVoice to true', async () => {
		const payload = await synthesizeToPayload(
			'Hello world',
			{ tmpDir: dir }
		)

		expect(payload.audioAsVoice).toBe(true)
	})

	test('temp file is created', async () => {
		const payload = await synthesizeToPayload(
			'Hello world',
			{ tmpDir: dir }
		)

		expect(existsSync(payload.mediaRefs![0])).toBe(true)
	})

	test('strips markdown before synthesis', async () => {
		mockTTS.mockClear()

		await synthesizeToPayload('**bold** text', {
			tmpDir: dir
		})

		expect(mockTTS).toHaveBeenCalledTimes(1)
		const callArgs = (
			mockTTS.mock.calls as unknown[][]
		)[0][0] as Record<string, unknown>
		expect(callArgs.text).toBe('bold text')
	})

	test('passes voiceId override', async () => {
		mockTTS.mockClear()

		await synthesizeToPayload('Hello', {
			tmpDir: dir,
			voiceId: 'customVoiceId123'
		})

		const callArgs = (
			mockTTS.mock.calls as unknown[][]
		)[0][0] as Record<string, Record<string, unknown>>
		expect(callArgs.overrides?.voiceId).toBe(
			'customVoiceId123'
		)
	})

	test('passes opus format when preferOpus', async () => {
		mockTTS.mockClear()

		// Return opus result for this call
		mockTTS.mockImplementationOnce(() =>
			Promise.resolve({
				audio: Buffer.from('fake-opus'),
				outputFormat: 'opus_16000',
				mime: 'audio/ogg',
				extension: 'opus',
				voiceCompatible: true,
				provider: 'elevenlabs' as const
			})
		)

		const payload = await synthesizeToPayload('Hello', {
			tmpDir: dir,
			preferOpus: true
		})

		const callArgs = (
			mockTTS.mock.calls as unknown[][]
		)[0][0] as Record<string, Record<string, unknown>>
		expect(callArgs.overrides?.outputFormat).toBe(
			'opus_16000'
		)
		expect(payload.mediaRefs![0]).toEndWith('.opus')
	})

	test('does not include text in payload', async () => {
		const payload = await synthesizeToPayload(
			'Hello world',
			{ tmpDir: dir }
		)

		expect(payload.text).toBeUndefined()
	})
})
