import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach,
	mock
} from 'bun:test'
import { ChannelDeliveryRegistry } from './delivery-registry'
import { EventStore } from '@ellie/db'
import { RealtimeStore } from '../../lib/realtime-store'
import type { ChannelProvider } from './provider'
import type { ChannelDeliveryTarget } from './types'
import type { TtsAutoMode } from './auto-tts'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'

// ── Mock TTS synthesis so no real API calls are made ────────────────────

const mockSynthesize = mock(() => {
	const tmpDir = tmpdir()
	const fakeAudioPath = join(
		tmpDir,
		`ellie-tts-e2e-${Date.now()}.opus`
	)
	writeFileSync(fakeAudioPath, 'fake-tts-audio')
	return Promise.resolve({
		audio: Buffer.from('fake-tts-audio'),
		outputFormat: 'opus_16000',
		mime: 'audio/ogg; codecs=opus',
		extension: 'opus'
	})
})

mock.module('../../lib/tts', () => ({
	elevenLabsTTS: mockSynthesize
}))

// ── Helpers ─────────────────────────────────────────────────────────────

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'e2e-tts-test-'))
}

function createTestStores(dir: string) {
	const eventStore = new EventStore(`${dir}/events.db`)
	const store = new RealtimeStore(
		eventStore,
		'test-session'
	)
	return { eventStore, store }
}

function makeAssistantPayload(
	text: string,
	_runId: string
) {
	return {
		message: {
			role: 'assistant' as const,
			content: [{ type: 'text' as const, text }],
			provider: 'anthropic',
			model: 'test',
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			stopReason: 'stop' as const,
			timestamp: Date.now()
		},
		streaming: false
	}
}

// ── E2E Tests ───────────────────────────────────────────────────────────

describe('E2E: TTS pipeline through delivery registry', () => {
	let dir: string
	let store: RealtimeStore
	let sentMessages: Array<{
		target: ChannelDeliveryTarget
		text: string
	}>
	let sentMedia: Array<{
		target: ChannelDeliveryTarget
		text: string
		media: {
			buffer: Buffer
			mimetype: string
			fileName?: string
		}
	}>
	let sentComposing: Array<{
		target: ChannelDeliveryTarget
	}>

	const mockProvider: ChannelProvider = {
		id: 'test',
		displayName: 'Test',
		boot: async () => {},
		shutdown: async () => {},
		getStatus: () => ({
			state: 'disconnected' as const,
			reconnectAttempts: 0
		}),
		loginStart: async () => ({}),
		loginWait: async () => ({}),
		logout: async () => {},
		updateSettings: () => {},
		sendMessage: async (target, text) => {
			sentMessages.push({ target, text })
			return {}
		},
		sendMedia: async (target, text, media) => {
			sentMedia.push({ target, text, media })
			return {}
		},
		sendComposing: async target => {
			sentComposing.push({ target })
		}
	}

	beforeEach(() => {
		dir = createTempDir()
		const stores = createTestStores(dir)
		store = stores.store
		sentMessages = []
		sentMedia = []
		sentComposing = []
		mockSynthesize.mockClear()
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	function createRegistry(ttsMode: TtsAutoMode) {
		return new ChannelDeliveryRegistry({
			store,
			getProvider: id =>
				id === 'test' ? mockProvider : undefined,
			getTtsConfig: () => ({
				mode: ttsMode,
				maxTextLength: 1500,
				minTextLength: 10
			})
		})
	}

	function emitRunWithText(
		sessionId: string,
		runId: string,
		text: string
	) {
		store.appendEvent(
			sessionId,
			'assistant_message',
			makeAssistantPayload(text, runId),
			runId
		)
		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)
	}

	test('inbound voice note triggers auto-TTS in inbound mode', async () => {
		const registry = createRegistry('inbound')
		const sessionId = 'test-session'
		const runId = 'run-inbound-voice'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-voice',
			inboundMediaType: 'audio/ogg; codecs=opus'
		}

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		emitRunWithText(
			sessionId,
			runId,
			'The weather is sunny and 72 degrees Fahrenheit today.'
		)

		await new Promise(r => setTimeout(r, 100))

		// TTS was called
		expect(mockSynthesize).toHaveBeenCalledTimes(1)
		// Delivered as media (voice note), not text
		expect(sentMedia).toHaveLength(1)
		expect(sentMessages).toHaveLength(0)
		// Voice note → empty caption
		expect(sentMedia[0].text).toBe('')
		// Composing sent at least once (register + deliver may each send one)
		expect(sentComposing.length).toBeGreaterThanOrEqual(1)

		registry.shutdown()
	})

	test('inbound text does NOT trigger auto-TTS in inbound mode', async () => {
		const registry = createRegistry('inbound')
		const sessionId = 'test-session'
		const runId = 'run-inbound-text'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-text'
			// No inboundMediaType → text message
		}

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		emitRunWithText(
			sessionId,
			runId,
			'The weather is sunny and 72 degrees Fahrenheit today.'
		)

		await new Promise(r => setTimeout(r, 100))

		// No TTS
		expect(mockSynthesize).toHaveBeenCalledTimes(0)
		// Delivered as plain text
		expect(sentMessages).toHaveLength(1)
		expect(sentMedia).toHaveLength(0)
		expect(sentMessages[0].text).toBe(
			'The weather is sunny and 72 degrees Fahrenheit today.'
		)

		registry.shutdown()
	})

	test('always mode applies TTS to all text replies', async () => {
		const registry = createRegistry('always')
		const sessionId = 'test-session'
		const runId = 'run-always'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-always'
		}

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		emitRunWithText(
			sessionId,
			runId,
			'This should be spoken as a voice note reply.'
		)

		await new Promise(r => setTimeout(r, 100))

		expect(mockSynthesize).toHaveBeenCalledTimes(1)
		expect(sentMedia).toHaveLength(1)
		expect(sentMessages).toHaveLength(0)

		registry.shutdown()
	})

	test('off mode never applies TTS', async () => {
		const registry = createRegistry('off')
		const sessionId = 'test-session'
		const runId = 'run-off'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-off',
			inboundMediaType: 'audio/ogg'
		}

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		emitRunWithText(
			sessionId,
			runId,
			'This should NOT be spoken even though inbound was audio.'
		)

		await new Promise(r => setTimeout(r, 100))

		expect(mockSynthesize).toHaveBeenCalledTimes(0)
		expect(sentMessages).toHaveLength(1)
		expect(sentMedia).toHaveLength(0)

		registry.shutdown()
	})

	test('tagged mode triggers TTS only when [[tts]] tag present', async () => {
		const registry = createRegistry('tagged')
		const sessionId = 'test-session'
		const runId = 'run-tagged'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-tagged'
		}

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		emitRunWithText(
			sessionId,
			runId,
			'Here is the weather forecast for today. [[tts]]'
		)

		await new Promise(r => setTimeout(r, 100))

		expect(mockSynthesize).toHaveBeenCalledTimes(1)
		expect(sentMedia).toHaveLength(1)
		expect(sentMessages).toHaveLength(0)

		registry.shutdown()
	})

	test('tagged mode skips when no [[tts]] tag', async () => {
		const registry = createRegistry('tagged')
		const sessionId = 'test-session'
		const runId = 'run-tagged-no'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-tagged-no'
		}

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		emitRunWithText(
			sessionId,
			runId,
			'Here is the weather forecast without any tag.'
		)

		await new Promise(r => setTimeout(r, 100))

		expect(mockSynthesize).toHaveBeenCalledTimes(0)
		expect(sentMessages).toHaveLength(1)
		expect(sentMedia).toHaveLength(0)

		registry.shutdown()
	})

	test('short text skips TTS even in always mode', async () => {
		const registry = createRegistry('always')
		const sessionId = 'test-session'
		const runId = 'run-short'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-short'
		}

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		emitRunWithText(sessionId, runId, 'OK')

		await new Promise(r => setTimeout(r, 100))

		// Too short for TTS → text only
		expect(mockSynthesize).toHaveBeenCalledTimes(0)
		expect(sentMessages).toHaveLength(1)
		expect(sentMedia).toHaveLength(0)

		registry.shutdown()
	})

	test('explicit MEDIA: directive takes priority over auto-TTS', async () => {
		const registry = createRegistry('always')
		const sessionId = 'test-session'
		const runId = 'run-explicit-media'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-explicit'
		}

		// Create a real temp file for the MEDIA: ref
		const mediaPath = join(dir, 'voice.opus')
		writeFileSync(mediaPath, 'pre-made-audio')

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		emitRunWithText(
			sessionId,
			runId,
			`Check this out\nMEDIA:${mediaPath}`
		)

		await new Promise(r => setTimeout(r, 100))

		// TTS was NOT called — explicit media takes priority
		expect(mockSynthesize).toHaveBeenCalledTimes(0)
		// Sent as media via the directive path
		expect(sentMedia).toHaveLength(1)
		expect(sentMedia[0].media.mimetype).toBe(
			'audio/ogg; codecs=opus'
		)

		registry.shutdown()
	})

	test('TTS synthesis failure falls back to text delivery', async () => {
		mockSynthesize.mockImplementationOnce(() =>
			Promise.reject(new Error('ElevenLabs API down'))
		)

		const registry = createRegistry('always')
		const sessionId = 'test-session'
		const runId = 'run-tts-fail'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-tts-fail'
		}

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		emitRunWithText(
			sessionId,
			runId,
			'This should be text because TTS will fail.'
		)

		await new Promise(r => setTimeout(r, 100))

		// TTS was attempted but failed
		expect(mockSynthesize).toHaveBeenCalledTimes(1)
		// Fell back to text
		expect(sentMessages).toHaveLength(1)
		expect(sentMedia).toHaveLength(0)
		expect(sentMessages[0].text).toBe(
			'This should be text because TTS will fail.'
		)

		registry.shutdown()
	})

	test('multi-target fan-out with auto-TTS', async () => {
		const registry = createRegistry('always')
		const sessionId = 'test-session'
		const runId = 'run-fanout-tts'

		const target1: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-fan-1'
		}
		const target2: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-fan-2'
		}

		registry.register(runId, sessionId, target1)
		registry.register(runId, sessionId, target2)
		registry.watchSession(sessionId)

		emitRunWithText(
			sessionId,
			runId,
			'Multi-target voice note delivery test message.'
		)

		await new Promise(r => setTimeout(r, 100))

		// TTS called once (payload is shared)
		expect(mockSynthesize).toHaveBeenCalledTimes(1)
		// Both targets receive media
		expect(sentMedia).toHaveLength(2)
		const convIds = sentMedia.map(
			m => m.target.conversationId
		)
		expect(convIds).toContain('conv-fan-1')
		expect(convIds).toContain('conv-fan-2')

		registry.shutdown()
	})

	test('getTtsConfig backward compat with getTtsAutoMode', async () => {
		// Test the deprecated getTtsAutoMode still works
		const registry = new ChannelDeliveryRegistry({
			store,
			getProvider: id =>
				id === 'test' ? mockProvider : undefined,
			getTtsAutoMode: () => 'always'
		})
		const sessionId = 'test-session'
		const runId = 'run-compat'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-compat'
		}

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		emitRunWithText(
			sessionId,
			runId,
			'Testing backward compatibility with getTtsAutoMode.'
		)

		await new Promise(r => setTimeout(r, 100))

		expect(mockSynthesize).toHaveBeenCalledTimes(1)
		expect(sentMedia).toHaveLength(1)

		registry.shutdown()
	})
})
