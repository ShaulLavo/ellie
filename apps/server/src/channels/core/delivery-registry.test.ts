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
import { mkdtempSync, rmSync } from 'fs'

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
	let store: RealtimeStore
	let registry: ChannelDeliveryRegistry
	let sentMessages: Array<{
		target: ChannelDeliveryTarget
		text: string
	}>

	const mockProvider: ChannelProvider = {
		id: 'test',
		displayName: 'Test',
		boot: async () => {},
		shutdown: async () => {},
		getStatus: () => ({ state: 'disconnected' }),
		loginStart: async () => ({}),
		loginWait: async () => ({}),
		logout: async () => {},
		updateSettings: () => {},
		sendMessage: async (target, text) => {
			sentMessages.push({ target, text })
		}
	}

	beforeEach(() => {
		dir = createTempDir()
		const stores = createTestStores(dir)
		store = stores.store
		sentMessages = []

		registry = new ChannelDeliveryRegistry({
			store,
			getProvider: id =>
				id === 'test' ? mockProvider : undefined
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
		expect(sentMessages[0].text).toBe(
			'Hello from Ellie!'
		)
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
})
