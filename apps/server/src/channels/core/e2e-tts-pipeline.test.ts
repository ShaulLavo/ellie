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
import { TtsPostProcessor } from '../../lib/tts-post-processor'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync
} from 'fs'

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
			dataDir: dir,
			getTtsConfig: () => ({
				mode: ttsMode,
				maxTextLength: 1500,
				minTextLength: 10
			})
		})
	}

	function attachTtsPostProcessor(
		registry: ChannelDeliveryRegistry
	) {
		const blobSink = {
			write: async (opts: {
				content: string | Buffer
				mimeType: string
				ext: string
			}) => {
				const uploadId = `trace/test-run/tts-post/tts_output/mock.${opts.ext}`
				const uploadPath = join(dir, 'uploads', uploadId)
				mkdirSync(dirname(uploadPath), {
					recursive: true
				})
				writeFileSync(
					uploadPath,
					new Uint8Array(
						Buffer.isBuffer(opts.content)
							? opts.content
							: Buffer.from(opts.content)
					)
				)
				return {
					uploadId,
					url: `/api/uploads-rpc/${encodeURIComponent(uploadId)}/content`,
					storagePath: uploadPath,
					mimeType: opts.mimeType,
					sizeBytes: 0,
					ohash: 'mock',
					role: 'tts_output'
				}
			}
		}

		registry.setTtsPostProcessor(
			new TtsPostProcessor({
				store,
				blobSink: blobSink as never,
				dataDir: dir
			})
		)
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

		await new Promise(r => setTimeout(r, 150))

		// TTS was called
		expect(mockSynthesize).toHaveBeenCalledTimes(1)
		// Delivered as media (voice note), not text
		expect(sentMedia).toHaveLength(1)
		expect(sentMessages).toHaveLength(0)
		// Voice note → empty caption
		expect(sentMedia[0].text).toBe('')

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

		await new Promise(r => setTimeout(r, 150))

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

		await new Promise(r => setTimeout(r, 150))

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

		await new Promise(r => setTimeout(r, 150))

		expect(mockSynthesize).toHaveBeenCalledTimes(0)
		expect(sentMessages).toHaveLength(1)
		expect(sentMedia).toHaveLength(0)

		registry.shutdown()
	})

	test('tagged mode triggers TTS only when [[tts]] tag present', async () => {
		const registry = createRegistry('tagged')
		attachTtsPostProcessor(registry)
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

		await new Promise(r => setTimeout(r, 150))

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

		await new Promise(r => setTimeout(r, 150))

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

		await new Promise(r => setTimeout(r, 150))

		// Too short for TTS → text only
		expect(mockSynthesize).toHaveBeenCalledTimes(0)
		expect(sentMessages).toHaveLength(1)
		expect(sentMedia).toHaveLength(0)

		registry.shutdown()
	})

	test('media artifact takes priority over auto-TTS', async () => {
		const registry = createRegistry('always')
		const sessionId = 'test-session'
		const runId = 'run-explicit-media'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-explicit'
		}

		// Create an upload file that resolves from upload:path
		const uploadId = 'trace/run-explicit-media/voice.opus'
		const uploadPath = join(dir, 'uploads', uploadId)
		mkdirSync(dirname(uploadPath), { recursive: true })
		writeFileSync(uploadPath, 'pre-made-audio')

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		// Emit clean text + an assistant_artifact for the media
		const row = store.appendEvent(
			sessionId,
			'assistant_message',
			makeAssistantPayload('Check this out', runId),
			runId
		)
		store.appendEvent(
			sessionId,
			'assistant_artifact',
			{
				assistantRowId: row.id,
				kind: 'media',
				origin: 'tool_upload',
				uploadId,
				mime: 'audio/ogg; codecs=opus'
			},
			runId
		)
		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		// TTS was NOT called — media artifact takes priority
		expect(mockSynthesize).toHaveBeenCalledTimes(0)
		// Sent as media via the artifact path
		expect(sentMedia).toHaveLength(1)
		expect(sentMedia[0].text).toBe('Check this out')
		expect(sentMedia[0].media.mimetype).toBe(
			'audio/ogg; codecs=opus'
		)

		registry.shutdown()
	})

	test('ttsDirective with media artifact sends both media and voice note', async () => {
		const registry = createRegistry('off')
		const sessionId = 'test-session'
		const runId = 'run-explicit-tts-media'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-explicit-tts-media'
		}

		// Create an upload file for the media artifact
		const uploadId =
			'trace/run-explicit-tts-media/preview.png'
		const uploadPath = join(dir, 'uploads', uploadId)
		mkdirSync(dirname(uploadPath), { recursive: true })
		writeFileSync(uploadPath, 'fake-image')
		attachTtsPostProcessor(registry)

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		// Emit clean text with ttsDirective + media artifact
		const assistantPayload = makeAssistantPayload(
			'Here are the options.',
			runId
		)
		;(
			assistantPayload as Record<string, unknown>
		).ttsDirective = { params: undefined }
		const row = store.appendEvent(
			sessionId,
			'assistant_message',
			assistantPayload,
			runId
		)
		store.appendEvent(
			sessionId,
			'assistant_artifact',
			{
				assistantRowId: row.id,
				kind: 'media',
				origin: 'tool_upload',
				uploadId,
				mime: 'image/png'
			},
			runId
		)
		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 150))

		expect(mockSynthesize).toHaveBeenCalledTimes(1)
		expect(sentMessages).toHaveLength(0)
		expect(sentMedia).toHaveLength(2)
		expect(sentMedia[0].text).toBe('Here are the options.')
		expect(sentMedia[0].media.mimetype).toBe('image/png')
		expect(sentMedia[1].text).toBe('')
		expect(sentMedia[1].media.mimetype).toBe(
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

		await new Promise(r => setTimeout(r, 150))

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

		await new Promise(r => setTimeout(r, 150))

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
})
