import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach
} from 'bun:test'
import { ChannelDeliveryRegistry } from './delivery-registry'
import { EventStore } from '@ellie/db'
import { RealtimeStore } from '../../lib/realtime-store'
import type { ChannelProvider } from './provider'
import type { ChannelDeliveryTarget } from './types'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'delivery-test-'))
}

function createTestStores(dir: string) {
	const eventStore = new EventStore(`${dir}/events.db`)
	const store = new RealtimeStore(
		eventStore,
		'test-session'
	)
	return { eventStore, store }
}

describe('ChannelDeliveryRegistry', () => {
	let dir: string
	let eventStore: EventStore
	let store: RealtimeStore
	let registry: ChannelDeliveryRegistry
	let sentMessages: Array<{
		target: ChannelDeliveryTarget
		text: string
	}>
	let sentMedia: Array<{
		target: ChannelDeliveryTarget
		caption: string
		media: { buffer: Buffer; mimetype: string; fileName?: string }
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
		sendMedia: async (target, caption, media) => {
			sentMedia.push({ target, caption, media })
			return {}
		}
	}

	beforeEach(() => {
		dir = createTempDir()
		const stores = createTestStores(dir)
		eventStore = stores.eventStore
		store = stores.store
		sentMessages = []
		sentMedia = []

		registry = new ChannelDeliveryRegistry({
			store,
			getProvider: id =>
				id === 'test' ? mockProvider : undefined,
			dataDir: dir
		})
	})

	afterEach(() => {
		registry.shutdown()
		rmSync(dir, { recursive: true, force: true })
	})

	test('register stores pending delivery', () => {
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1'
		}
		registry.register('run-1', 'test-session', target)
		// No error means it stored successfully
	})

	test('run_closed triggers sendMessage with final assistant text', async () => {
		const sessionId = 'test-session'
		const runId = 'run-1'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1'
		}

		// Register delivery
		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		// Persist an assistant_message for this run
		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'Hello from Ellie!' }
					],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		// Emit run_closed
		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		// Wait for async delivery
		await new Promise(r => setTimeout(r, 50))

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe('Hello from Ellie!')
		expect(sentMessages[0].target).toEqual(target)
	})

	test('does not deliver for non-channel runs', async () => {
		const sessionId = 'test-session'
		registry.watchSession(sessionId)

		// Emit run_closed without registering any delivery
		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			'unregistered-run'
		)

		await new Promise(r => setTimeout(r, 50))
		expect(sentMessages).toHaveLength(0)
	})

	test('watchSession is idempotent', () => {
		registry.watchSession('test-session')
		registry.watchSession('test-session')
		// No error, no duplicate subscriptions
	})

	test('shutdown clears state', () => {
		registry.register('run-1', 'test-session', {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1'
		})
		registry.watchSession('test-session')
		registry.shutdown()
		// After shutdown, a new watchSession should work
		registry.watchSession('test-session')
	})

	// ── Multi-target fan-out ──────────────────────────────────────────────

	test('fans out to multiple contributing targets', async () => {
		const sessionId = 'test-session'
		const runId = 'run-multi'

		const target1: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1'
		}
		const target2: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-2'
		}

		registry.register(runId, sessionId, target1)
		registry.register(runId, sessionId, target2)
		registry.watchSession(sessionId)

		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'Reply to both' }
					],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentMessages).toHaveLength(2)
		const convIds = sentMessages.map(
			m => m.target.conversationId
		)
		expect(convIds).toContain('conv-1')
		expect(convIds).toContain('conv-2')
		expect(sentMessages[0].text).toBe('Reply to both')
		expect(sentMessages[1].text).toBe('Reply to both')
	})

	test('deduplicates same target registered twice', async () => {
		const sessionId = 'test-session'
		const runId = 'run-dedup'

		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1'
		}

		registry.register(runId, sessionId, target)
		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Once only' }],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentMessages).toHaveLength(1)
	})

	// ── Pending row-based binding ─────────────────────────────────────────

	test('registerPending promotes to run delivery on runId backfill', async () => {
		const sessionId = 'test-session'
		const runId = 'run-pending'

		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-pending'
		}

		// Persist a user_message without runId
		const row = store.appendEvent(
			sessionId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now()
			}
		)

		// Register pending against the row
		registry.registerPending(row.id, sessionId, target)
		registry.watchSession(sessionId)

		// Backfill the runId — this should promote the pending entry
		store.updateEventRunId(row.id, runId, sessionId)

		// Now persist assistant reply and close the run
		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: 'Pending resolved'
						}
					],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe('Pending resolved')
		expect(sentMessages[0].target).toEqual(target)
	})

	// ── Recovery / durability ────────────────────────────────────────────

	test('channel_delivered event is emitted after successful delivery', async () => {
		const sessionId = 'test-session'
		const runId = 'run-marker'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-marker'
		}

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Marker test' }],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		// Verify delivery happened
		expect(sentMessages).toHaveLength(1)

		// Verify channel_delivered marker was persisted
		const deliveredEvents = eventStore.query({
			sessionId,
			types: ['channel_delivered'],
			runId
		})
		expect(deliveredEvents).toHaveLength(1)
		const payload = JSON.parse(deliveredEvents[0].payload)
		expect(payload.channelId).toBe('test')
		expect(payload.accountId).toBe('default')
		expect(payload.conversationId).toBe('conv-marker')
	})

	test('recoverUndelivered re-delivers stranded channel runs', async () => {
		const sessionId = 'test-session'
		const runId = 'run-stranded'

		// Simulate a channel user_message with source metadata
		store.appendEvent(
			sessionId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'test',
					accountId: 'default',
					conversationId: 'conv-stranded',
					senderId: 'user-1',
					senderName: 'Test User'
				}
			},
			runId
		)

		// Simulate assistant reply
		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: 'Recovered reply'
						}
					],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		// Simulate run_closed (but NO channel_delivered — crash scenario)
		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		// Now recover
		const recovered =
			await registry.recoverUndelivered(eventStore)
		expect(recovered).toBe(1)
		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe('Recovered reply')
		expect(sentMessages[0].target.conversationId).toBe(
			'conv-stranded'
		)

		// Verify marker was written
		const deliveredEvents = eventStore.query({
			sessionId,
			types: ['channel_delivered'],
			runId
		})
		expect(deliveredEvents).toHaveLength(1)
	})

	test('recoverUndelivered skips already-delivered runs', async () => {
		const sessionId = 'test-session'
		const runId = 'run-already'

		store.appendEvent(
			sessionId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'test',
					accountId: 'default',
					conversationId: 'conv-already',
					senderId: 'user-1',
					senderName: 'Test User'
				}
			},
			runId
		)

		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Already sent' }],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		// Already has a channel_delivered marker
		store.appendEvent(
			sessionId,
			'channel_delivered',
			{
				channelId: 'test',
				accountId: 'default',
				conversationId: 'conv-already',
				deliveredAt: Date.now()
			},
			runId
		)

		const recovered =
			await registry.recoverUndelivered(eventStore)
		expect(recovered).toBe(0)
		expect(sentMessages).toHaveLength(0)
	})

	test('recoverUndelivered skips runs with unavailable provider', async () => {
		const sessionId = 'test-session'
		const runId = 'run-noprovider'

		store.appendEvent(
			sessionId,
			'user_message',
			{
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: Date.now(),
				source: {
					kind: 'whatsapp',
					channelId: 'unknown-channel',
					accountId: 'default',
					conversationId: 'conv-noprovider',
					senderId: 'user-1',
					senderName: 'Test User'
				}
			},
			runId
		)

		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'No provider' }],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		const recovered =
			await registry.recoverUndelivered(eventStore)
		expect(recovered).toBe(0)
		expect(sentMessages).toHaveLength(0)
	})

	test('stale run recovery triggers delivery when registry is watching', async () => {
		const sessionId = 'test-session'
		const runId = 'run-stale'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-stale'
		}

		// Register target and watch BEFORE the run closes
		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		// Persist assistant reply
		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'Stale recovery' }
					],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		// Simulate what recoverStaleRuns does at startup:
		// appends run_closed WHILE registry is watching
		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'recovered_after_crash' },
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe('Stale recovery')
	})

	test('web/internal runs never deliver externally', async () => {
		const sessionId = 'test-session'
		registry.watchSession(sessionId)

		// Simulate a purely internal run (no register/registerPending)
		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: 'Internal only'
						}
					],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			'internal-run'
		)

		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			'internal-run'
		)

		await new Promise(r => setTimeout(r, 50))

		expect(sentMessages).toHaveLength(0)
	})

	// ── Image generation auto-append ─────────────────────────────────────

	test('auto-appends generate_image media to reply payload', async () => {
		const sessionId = 'test-session'
		const runId = 'run-img'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-img'
		}

		// Create a real temp file so resolveMedia can read it
		const imgPath = join(tmpdir(), 'test-img-gen.png')
		const imgContent = Buffer.from('fake-png-content')
		writeFileSync(imgPath, new Uint8Array(imgContent))

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		// Assistant text
		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: 'Here is your image'
						}
					],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		// Completed tool_execution for generate_image
		store.appendEvent(
			sessionId,
			'tool_execution',
			{
				toolName: 'generate_image',
				toolCallId: 'tc-1',
				args: { prompt: 'a cat' },
				status: 'complete',
				result: {
					content: [
						{
							type: 'text',
							text: 'Image generated'
						}
					],
					details: {
						success: true,
						filePath: imgPath,
						uploadId: 'upload-123'
					}
				}
			},
			runId
		)

		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		// Should call sendMedia (not sendMessage) via resolveMedia → provider.sendMedia
		expect(sentMessages).toHaveLength(0)
		expect(sentMedia).toHaveLength(1)
		expect(sentMedia[0].caption).toBe('Here is your image')
		expect(sentMedia[0].target).toEqual(target)
		expect(sentMedia[0].media.mimetype).toBe('image/png')
		expect(sentMedia[0].media.buffer).toEqual(imgContent)

		// Cleanup
		rmSync(imgPath, { force: true })
	})

	test('failed generate_image does not add media', async () => {
		const sessionId = 'test-session'
		const runId = 'run-img-fail'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-img-fail'
		}

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: 'Image failed'
						}
					],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		// Failed tool_execution
		store.appendEvent(
			sessionId,
			'tool_execution',
			{
				toolName: 'generate_image',
				toolCallId: 'tc-2',
				args: { prompt: 'a dog' },
				status: 'error',
				result: {
					content: [
						{
							type: 'text',
							text: 'Generation failed'
						}
					],
					details: { success: false }
				}
			},
			runId
		)

		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		// Should send text-only via sendMessage (no sendMedia call)
		expect(sentMessages).toHaveLength(1)
		expect(sentMessages[0].text).toBe('Image failed')
		expect(sentMedia).toHaveLength(0)
	})

	test('legacy MEDIA: directives in text still work', async () => {
		const sessionId = 'test-session'
		const runId = 'run-legacy'
		const target: ChannelDeliveryTarget = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-legacy'
		}

		// Create a real temp file so resolveMedia can read it
		const legacyPath = join(tmpdir(), 'legacy-test.png')
		const legacyContent = Buffer.from('fake-legacy-png')
		writeFileSync(legacyPath, new Uint8Array(legacyContent))

		registry.register(runId, sessionId, target)
		registry.watchSession(sessionId)

		store.appendEvent(
			sessionId,
			'assistant_message',
			{
				message: {
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: `Here is the file\nMEDIA:${legacyPath}`
						}
					],
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
					stopReason: 'stop',
					timestamp: Date.now()
				},
				streaming: false
			},
			runId
		)

		store.appendEvent(
			sessionId,
			'run_closed',
			{ reason: 'completed' },
			runId
		)

		await new Promise(r => setTimeout(r, 50))

		// Should call sendMedia via resolveMedia → provider.sendMedia
		expect(sentMessages).toHaveLength(0)
		expect(sentMedia).toHaveLength(1)
		expect(sentMedia[0].caption).toBe('Here is the file')
		expect(sentMedia[0].media.mimetype).toBe('image/png')
		expect(sentMedia[0].media.buffer).toEqual(legacyContent)

		// Cleanup
		rmSync(legacyPath, { force: true })
	})
})
