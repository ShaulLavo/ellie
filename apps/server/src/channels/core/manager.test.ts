import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach
} from 'bun:test'
import { ChannelManager } from './manager'
import { ChannelDeliveryRegistry } from './delivery-registry'
import { EventStore } from '@ellie/db'
import { RealtimeStore } from '../../lib/realtime-store'
import type { ChannelProvider } from './provider'
import type { ChannelDeliveryTarget } from './types'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'manager-test-'))
}

function createTestStores(dir: string) {
	const eventStore = new EventStore(`${dir}/events.db`)
	const store = new RealtimeStore(
		eventStore,
		'test-session'
	)
	return { eventStore, store }
}

function createMockProvider(
	id: string,
	displayName: string
): ChannelProvider & { bootCalls: unknown[] } {
	const bootCalls: unknown[] = []
	return {
		id,
		displayName,
		bootCalls,
		boot: async manager => {
			bootCalls.push(manager)
		},
		shutdown: async () => {},
		getStatus: () => ({
			state: 'disconnected' as const,
			reconnectAttempts: 0
		}),
		loginStart: async () => ({}),
		loginWait: async () => ({}),
		logout: async () => {},
		updateSettings: () => {},
		sendMessage: async () => ({})
	}
}

describe('ChannelManager', () => {
	let dir: string
	let eventStore: EventStore
	let store: RealtimeStore
	let registry: ChannelDeliveryRegistry
	let manager: ChannelManager

	beforeEach(() => {
		dir = createTempDir()
		const stores = createTestStores(dir)
		eventStore = stores.eventStore
		store = stores.store

		registry = new ChannelDeliveryRegistry({
			store,
			getProvider: id =>
				manager.getProvider(id) ?? undefined
		})

		manager = new ChannelManager({
			dataDir: dir,
			store,
			getAgentController: async () => null,
			ensureBootstrap: () => {},
			deliveryRegistry: registry
		})
	})

	afterEach(() => {
		registry.shutdown()
		rmSync(dir, { recursive: true, force: true })
	})

	test('register + getProvider', () => {
		const provider = createMockProvider(
			'test',
			'Test Channel'
		)
		manager.register(provider)
		expect(manager.getProvider('test')).toBe(provider)
		expect(
			manager.getProvider('nonexistent')
		).toBeUndefined()
	})

	test('listProviders returns all registered', () => {
		const p1 = createMockProvider('a', 'Channel A')
		const p2 = createMockProvider('b', 'Channel B')
		manager.register(p1)
		manager.register(p2)
		const list = manager.listProviders()
		expect(list).toHaveLength(2)
		expect(list.map(p => p.id).sort()).toEqual(['a', 'b'])
	})

	test('saveSettings + loadSettings round-trip', async () => {
		const settings = {
			phoneMode: 'self',
			foo: 'bar'
		}
		await manager.saveSettings('test', 'default', settings)
		const loaded = await manager.loadSettings(
			'test',
			'default'
		)
		expect(loaded).toEqual(settings)
	})

	test('loadSettings returns null when no settings exist', async () => {
		expect(
			await manager.loadSettings('test', 'default')
		).toBeNull()
	})

	test('listSavedAccounts returns account dirs', async () => {
		await manager.saveSettings('test', 'default', {
			mode: 'a'
		})
		await manager.saveSettings('test', 'work', {
			mode: 'b'
		})
		const accounts = manager
			.listSavedAccounts('test')
			.sort()
		expect(accounts).toEqual(['default', 'work'])
	})

	test('listSavedAccounts returns empty for unknown channel', () => {
		expect(manager.listSavedAccounts('unknown')).toEqual([])
	})

	test('deleteAccountData removes the account dir', async () => {
		await manager.saveSettings('test', 'default', {
			x: 1
		})
		expect(
			await manager.loadSettings('test', 'default')
		).not.toBeNull()
		manager.deleteAccountData('test', 'default')
		expect(
			await manager.loadSettings('test', 'default')
		).toBeNull()
	})

	test('bootAll calls provider.boot when settings exist', async () => {
		const provider = createMockProvider('test', 'Test')
		manager.register(provider)
		await manager.saveSettings('test', 'default', {
			mode: 'self'
		})

		await manager.bootAll()
		expect(provider.bootCalls).toHaveLength(1)
		expect(provider.bootCalls[0]).toBe(manager)
	})

	test('bootAll calls boot even without saved accounts', async () => {
		const provider = createMockProvider('test', 'Test')
		manager.register(provider)

		await manager.bootAll()
		// boot is always called so providers can set their manager reference
		expect(provider.bootCalls).toHaveLength(1)
	})

	test('bootAll does not throw on provider boot failure', async () => {
		const provider = createMockProvider('test', 'Test')
		provider.boot = async () => {
			throw new Error('boot failed')
		}
		manager.register(provider)
		await manager.saveSettings('test', 'default', {
			mode: 'self'
		})

		// Should not throw
		await manager.bootAll()
	})

	test('multiple providers both get booted', async () => {
		const p1 = createMockProvider('wa', 'WhatsApp')
		const p2 = createMockProvider('tg', 'Telegram')
		manager.register(p1)
		manager.register(p2)

		await manager.saveSettings('wa', 'default', {
			mode: 'self'
		})

		await manager.bootAll()
		expect(p1.bootCalls).toHaveLength(1)
		expect(p2.bootCalls).toHaveLength(1)
	})

	test('ingestMessage creates user_message with source field', async () => {
		const handleMessageCalls: Array<{
			sessionId: string
			text: string
			eventId: number
		}> = []
		const registerCalls: Array<{
			runId: string
			sessionId: string
			target: ChannelDeliveryTarget
		}> = []

		// Create a new manager with a mock controller
		const testManager = new ChannelManager({
			dataDir: dir,
			store,
			getAgentController: async () =>
				({
					handleMessage: async (
						sessionId: string,
						text: string,
						eventId: number
					) => {
						handleMessageCalls.push({
							sessionId,
							text,
							eventId
						})
						return {
							runId: 'run-123',
							routed: 'prompt'
						}
					}
				}) as never,
			ensureBootstrap: () => {},
			deliveryRegistry: {
				register: (
					runId: string,
					sessionId: string,
					target: ChannelDeliveryTarget
				) => {
					registerCalls.push({
						runId,
						sessionId,
						target
					})
				},
				registerPending: () => {},
				watchSession: () => {}
			} as never
		})

		await testManager.ingestMessage({
			channelId: 'whatsapp',
			accountId: 'default',
			conversationId: '1234@s.whatsapp.net',
			senderId: '1234@s.whatsapp.net',
			senderName: 'Alice',
			text: 'Hello Ellie',
			timestamp: Date.now()
		})

		// Controller was called
		expect(handleMessageCalls).toHaveLength(1)
		expect(handleMessageCalls[0].text).toBe('Hello Ellie')

		// Delivery was registered
		expect(registerCalls).toHaveLength(1)
		expect(registerCalls[0].runId).toBe('run-123')
		expect(registerCalls[0].target.channelId).toBe(
			'whatsapp'
		)
		expect(registerCalls[0].target.conversationId).toBe(
			'1234@s.whatsapp.net'
		)

		// user_message was persisted with source
		const allEvents = eventStore.query({
			sessionId: 'test-session'
		})
		const userMsg = allEvents.find(
			e => e.type === 'user_message'
		)
		expect(userMsg).toBeDefined()
		const payload = JSON.parse(userMsg!.payload)
		expect(payload.source).toEqual({
			kind: 'whatsapp',
			channelId: 'whatsapp',
			accountId: 'default',
			conversationId: '1234@s.whatsapp.net',
			senderId: '1234@s.whatsapp.net',
			senderName: 'Alice'
		})
	})

	test('ingestMessage deduplicates by externalId', async () => {
		let handleCount = 0
		const testManager = new ChannelManager({
			dataDir: dir,
			store,
			getAgentController: async () =>
				({
					handleMessage: async () => {
						handleCount++
						return {
							runId: 'run-1',
							routed: 'prompt'
						}
					}
				}) as never,
			ensureBootstrap: () => {},
			deliveryRegistry: {
				register: () => {},
				registerPending: () => {},
				watchSession: () => {}
			} as never
		})

		const baseMsg = {
			channelId: 'whatsapp',
			accountId: 'default',
			conversationId: '123@s.whatsapp.net',
			senderId: '+15550001111',
			text: 'Hello',
			timestamp: Date.now(),
			externalId: 'WAMID_001'
		}

		await testManager.ingestMessage(baseMsg)
		await testManager.ingestMessage(baseMsg)

		// Second call is a dedupe hit — controller only called once
		expect(handleCount).toBe(1)
	})

	test('ingestMessage accepts different externalIds with same text', async () => {
		let handleCount = 0
		const testManager = new ChannelManager({
			dataDir: dir,
			store,
			getAgentController: async () =>
				({
					handleMessage: async () => {
						handleCount++
						return {
							runId: `run-${handleCount}`,
							routed: 'prompt'
						}
					}
				}) as never,
			ensureBootstrap: () => {},
			deliveryRegistry: {
				register: () => {},
				registerPending: () => {},
				watchSession: () => {}
			} as never
		})

		const baseMsg = {
			channelId: 'whatsapp',
			accountId: 'default',
			conversationId: '123@s.whatsapp.net',
			senderId: '+15550001111',
			text: 'Hello',
			timestamp: Date.now()
		}

		await testManager.ingestMessage({
			...baseMsg,
			externalId: 'WAMID_001'
		})
		await testManager.ingestMessage({
			...baseMsg,
			externalId: 'WAMID_002'
		})

		// Both accepted — different externalIds
		expect(handleCount).toBe(2)
	})

	test('ingestMessage without externalId uses hash-based dedupe', async () => {
		let handleCount = 0
		const testManager = new ChannelManager({
			dataDir: dir,
			store,
			getAgentController: async () =>
				({
					handleMessage: async () => {
						handleCount++
						return {
							runId: `run-${handleCount}`,
							routed: 'prompt'
						}
					}
				}) as never,
			ensureBootstrap: () => {},
			deliveryRegistry: {
				register: () => {},
				registerPending: () => {},
				watchSession: () => {}
			} as never
		})

		const baseMsg = {
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1',
			senderId: 'sender-1',
			text: 'Hello',
			timestamp: Date.now()
			// no externalId
		}

		await testManager.ingestMessage(baseMsg)
		await testManager.ingestMessage(baseMsg)

		// Same content in same 2s window — deduplicated
		expect(handleCount).toBe(1)
	})

	test('ingestMessage drops message when agent not available', async () => {
		// Default manager has getAgentController returning null
		// Should not throw, just log warning
		await manager.ingestMessage({
			channelId: 'test',
			accountId: 'default',
			conversationId: 'conv-1',
			senderId: 'sender-1',
			text: 'Hello',
			timestamp: Date.now()
		})
		// No error means it handled gracefully
	})
})
