import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach,
	mock
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
		getStatus: () => ({ state: 'disconnected' }),
		loginStart: async () => ({}),
		loginWait: async () => ({}),
		logout: async () => {},
		updateSettings: () => {},
		sendMessage: async () => {}
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

	// ── Provider registry ────────────────────────────────────

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

	// ── Settings persistence ────────────────────────────────

	test('saveSettings + loadSettings round-trip', () => {
		const settings = {
			phoneMode: 'self',
			foo: 'bar'
		}
		manager.saveSettings('test', 'default', settings)
		const loaded = manager.loadSettings('test', 'default')
		expect(loaded).toEqual(settings)
	})

	test('loadSettings returns null when no settings exist', () => {
		expect(
			manager.loadSettings('test', 'default')
		).toBeNull()
	})

	test('listSavedAccounts returns account dirs', () => {
		manager.saveSettings('test', 'default', {
			mode: 'a'
		})
		manager.saveSettings('test', 'work', {
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

	test('deleteAccountData removes the account dir', () => {
		manager.saveSettings('test', 'default', {
			x: 1
		})
		expect(
			manager.loadSettings('test', 'default')
		).not.toBeNull()
		manager.deleteAccountData('test', 'default')
		expect(
			manager.loadSettings('test', 'default')
		).toBeNull()
	})

	// ── Boot ─────────────────────────────────────────────────

	test('bootAll calls provider.boot when settings exist', async () => {
		const provider = createMockProvider('test', 'Test')
		manager.register(provider)
		manager.saveSettings('test', 'default', {
			mode: 'self'
		})

		await manager.bootAll()
		expect(provider.bootCalls).toHaveLength(1)
		expect(provider.bootCalls[0]).toBe(manager)
	})

	test('bootAll skips provider without saved accounts', async () => {
		const provider = createMockProvider('test', 'Test')
		manager.register(provider)

		await manager.bootAll()
		expect(provider.bootCalls).toHaveLength(0)
	})

	test('bootAll does not throw on provider boot failure', async () => {
		const provider = createMockProvider('test', 'Test')
		provider.boot = async () => {
			throw new Error('boot failed')
		}
		manager.register(provider)
		manager.saveSettings('test', 'default', {
			mode: 'self'
		})

		// Should not throw
		await manager.bootAll()
	})

	// ── Multiple providers ───────────────────────────────────

	test('multiple providers coexist independently', async () => {
		const p1 = createMockProvider('wa', 'WhatsApp')
		const p2 = createMockProvider('tg', 'Telegram')
		manager.register(p1)
		manager.register(p2)

		manager.saveSettings('wa', 'default', {
			mode: 'self'
		})
		// tg has no saved settings

		await manager.bootAll()
		expect(p1.bootCalls).toHaveLength(1)
		expect(p2.bootCalls).toHaveLength(0)
	})

	// ── Ingestion ────────────────────────────────────────────

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
						return { runId: 'run-123' }
					}
				}) as any,
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
				watchSession: () => {}
			} as any
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
		const events = store.queryRunEvents('test-session', '')
		// Query all events in session instead
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
