import { describe, expect, test } from 'bun:test'
import {
	parseReplyDirectives,
	buildReplyPayload
} from './reply-payload'

describe('parseReplyDirectives', () => {
	test('plain text (no directives)', () => {
		const result = parseReplyDirectives('Hello world')
		expect(result).toEqual({
			text: 'Hello world',
			mediaRefs: [],
			audioAsVoice: false
		})
	})

	test('single MEDIA ref', () => {
		const result = parseReplyDirectives(
			'Here is audio\nMEDIA:/tmp/voice.opus'
		)
		expect(result).toEqual({
			text: 'Here is audio',
			mediaRefs: ['/tmp/voice.opus'],
			audioAsVoice: false
		})
	})

	test('quoted MEDIA ref', () => {
		const result = parseReplyDirectives(
			'MEDIA:"/tmp/my file.mp3"'
		)
		expect(result.mediaRefs).toEqual(['/tmp/my file.mp3'])
	})

	test('audio_as_voice flag', () => {
		const result = parseReplyDirectives(
			'Listen to this [[audio_as_voice]]'
		)
		expect(result.text).toBe('Listen to this')
		expect(result.audioAsVoice).toBe(true)
	})

	test('MEDIA + audio_as_voice', () => {
		const result = parseReplyDirectives(
			'MEDIA:/tmp/a.opus\n[[audio_as_voice]]'
		)
		expect(result.mediaRefs).toEqual(['/tmp/a.opus'])
		expect(result.audioAsVoice).toBe(true)
	})

	test('multiple MEDIA refs', () => {
		const result = parseReplyDirectives(
			'MEDIA:/a.mp3\ntext\nMEDIA:/b.png'
		)
		expect(result.text).toBe('text')
		expect(result.mediaRefs).toEqual(['/a.mp3', '/b.png'])
	})

	test('directive inside code fence is ignored', () => {
		const result = parseReplyDirectives(
			'```\nMEDIA:/fake\n```'
		)
		expect(result.text).toBe('```\nMEDIA:/fake\n```')
		expect(result.mediaRefs).toEqual([])
	})

	test('blank-line collapse', () => {
		const result = parseReplyDirectives('a\n\n\n\nb')
		expect(result.text).toBe('a\n\nb')
	})

	test('case-insensitive MEDIA', () => {
		const result = parseReplyDirectives(
			'media:/tmp/test.mp3'
		)
		expect(result.mediaRefs).toEqual(['/tmp/test.mp3'])
	})

	test('case-insensitive audio_as_voice', () => {
		const result = parseReplyDirectives(
			'hi [[AUDIO_AS_VOICE]]'
		)
		expect(result.audioAsVoice).toBe(true)
		expect(result.text).toBe('hi')
	})

	test('media-only (no text left)', () => {
		const result = parseReplyDirectives(
			'MEDIA:/tmp/img.png'
		)
		expect(result.text).toBe('')
		expect(result.mediaRefs).toEqual(['/tmp/img.png'])
	})
})

describe('buildReplyPayload', () => {
	test('plain text returns text only', () => {
		const payload = buildReplyPayload('Hello')
		expect(payload).toEqual({ text: 'Hello' })
		expect(payload.mediaRefs).toBeUndefined()
		expect(payload.audioAsVoice).toBeUndefined()
	})

	test('media-only returns no text', () => {
		const payload = buildReplyPayload('MEDIA:/tmp/img.png')
		expect(payload.text).toBeUndefined()
		expect(payload.mediaRefs).toEqual(['/tmp/img.png'])
	})

	test('full payload with all fields', () => {
		const payload = buildReplyPayload(
			'Listen\nMEDIA:/tmp/a.opus\n[[audio_as_voice]]'
		)
		expect(payload).toEqual({
			text: 'Listen',
			mediaRefs: ['/tmp/a.opus'],
			audioAsVoice: true
		})
	})
})
