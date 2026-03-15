import { describe, expect, test, mock } from 'bun:test'
import { maybeApplyTtsToPayload } from './auto-tts'
import type { ChannelReplyPayload } from './reply-payload'

// Mock the TTS synthesis — avoid real API calls
const mockSynthesize = mock(() =>
	Promise.resolve({
		mediaRefs: ['/tmp/ellie-tts-mock.opus'],
		audioAsVoice: true
	} as ChannelReplyPayload)
)

mock.module('./reply-tts', () => ({
	synthesizeToPayload: mockSynthesize,
	stripMarkdownForTts: (text: string) =>
		text
			.replace(/\*\*([^*]*)\*\*/g, '$1')
			.replace(/\*([^*]*)\*/g, '$1')
			.trim(),
	truncateForTts: (text: string, max: number = 1500) =>
		text.length <= max ? text : text.slice(0, max) + '...'
}))

describe('maybeApplyTtsToPayload — mode tests', () => {
	test('off mode — no TTS', async () => {
		const payload: ChannelReplyPayload = {
			text: 'Hello world, this is a test message'
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'off'
		})
		expect(result).toBe(payload) // Same reference — unchanged
	})

	test('always mode — applies TTS', async () => {
		mockSynthesize.mockClear()
		const payload: ChannelReplyPayload = {
			text: 'Hello world, this is a longer message for TTS'
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'always'
		})
		expect(result.mediaRefs).toBeDefined()
		expect(result.audioAsVoice).toBe(true)
		expect(mockSynthesize).toHaveBeenCalledTimes(1)
	})

	test('inbound mode — voice message triggers TTS', async () => {
		mockSynthesize.mockClear()
		const payload: ChannelReplyPayload = {
			text: 'Replying to your voice note here'
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'inbound',
			inboundAudio: true
		})
		expect(result.mediaRefs).toBeDefined()
		expect(result.audioAsVoice).toBe(true)
	})

	test('inbound mode — text message skips TTS', async () => {
		const payload: ChannelReplyPayload = {
			text: 'Replying to your text message here'
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'inbound',
			inboundAudio: false
		})
		expect(result).toBe(payload)
	})

	test('tagged mode — has [[tts]] triggers TTS', async () => {
		mockSynthesize.mockClear()
		const payload: ChannelReplyPayload = {
			text: 'Hello there [[tts]]'
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'tagged'
		})
		expect(result.mediaRefs).toBeDefined()
		expect(result.audioAsVoice).toBe(true)
		// [[tts]] should be stripped from output text
		expect(result.text).toBe('Hello there')
	})

	test('tagged mode — no tag skips TTS', async () => {
		const payload: ChannelReplyPayload = {
			text: 'Hello there, no tag here though'
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'tagged'
		})
		expect(result).toBe(payload)
	})
})

describe('maybeApplyTtsToPayload — skip conditions', () => {
	test('already has media — skipped', async () => {
		const payload: ChannelReplyPayload = {
			text: 'Some text that would be long enough',
			mediaRefs: ['/a.mp3']
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'always'
		})
		expect(result).toBe(payload)
	})

	test('text too short — skipped', async () => {
		const payload: ChannelReplyPayload = { text: 'ok' }
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'always'
		})
		expect(result).toBe(payload)
	})

	test('no text — skipped', async () => {
		const payload: ChannelReplyPayload = {
			mediaRefs: ['/a.mp3']
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'always'
		})
		expect(result).toBe(payload)
	})

	test('text has MEDIA: — skipped', async () => {
		const payload: ChannelReplyPayload = {
			text: 'MEDIA:/tmp/a.mp3'
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'always'
		})
		expect(result).toBe(payload)
	})

	test('custom minTextLength respected', async () => {
		const payload: ChannelReplyPayload = {
			text: 'Short msg.'
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'always',
			minTextLength: 50
		})
		expect(result).toBe(payload)
	})
})

describe('maybeApplyTtsToPayload — processing', () => {
	test('strips markdown before synthesis', async () => {
		mockSynthesize.mockClear()
		const payload: ChannelReplyPayload = {
			text: '**bold** message that is long enough for TTS'
		}
		await maybeApplyTtsToPayload({
			payload,
			mode: 'always'
		})
		expect(mockSynthesize).toHaveBeenCalledTimes(1)
		// The mock stripMarkdown removes ** markers
		const callText = (
			mockSynthesize.mock.calls as unknown[][]
		)[0][0]
		expect(callText).not.toContain('**')
	})

	test('TTS failure returns original payload', async () => {
		mockSynthesize.mockImplementationOnce(() =>
			Promise.reject(new Error('API down'))
		)
		const payload: ChannelReplyPayload = {
			text: 'Hello world, this is a test for TTS failure'
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'always'
		})
		expect(result).toBe(payload)
	})

	test('[[tts]] stripped from output text', async () => {
		mockSynthesize.mockClear()
		const payload: ChannelReplyPayload = {
			text: 'Hello [[tts]] world'
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'tagged'
		})
		expect(result.text).toBe('Hello  world')
	})

	test('preserves original text in merged payload', async () => {
		mockSynthesize.mockClear()
		const payload: ChannelReplyPayload = {
			text: 'Original message text that is long enough'
		}
		const result = await maybeApplyTtsToPayload({
			payload,
			mode: 'always'
		})
		expect(result.text).toBe(
			'Original message text that is long enough'
		)
		expect(result.mediaRefs).toBeDefined()
	})

	test('passes ttsOptions through', async () => {
		mockSynthesize.mockClear()
		const payload: ChannelReplyPayload = {
			text: 'Message with custom voice setting option'
		}
		await maybeApplyTtsToPayload({
			payload,
			mode: 'always',
			ttsOptions: {
				voiceId: 'customVoice123'
			}
		})
		const callOpts = (
			mockSynthesize.mock.calls as unknown[][]
		)[0][1] as Record<string, unknown>
		expect(callOpts.voiceId).toBe('customVoice123')
		expect(callOpts.preferOpus).toBe(true)
	})
})
