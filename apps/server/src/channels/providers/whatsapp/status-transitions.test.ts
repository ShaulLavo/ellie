import {
	describe,
	test,
	expect,
	beforeEach,
	afterEach,
	mock
} from 'bun:test'

// Mock Baileys (same pattern as provider.test.ts)
mock.module('@whiskeysockets/baileys', () => {
	const noop = () => {}
	const noopAsync = async () => ({})
	const silentLogger = {
		level: 'silent',
		child: () => silentLogger,
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop
	}
	return {
		default: () => ({}),
		makeWASocket: () => ({}),
		DisconnectReason: {
			loggedOut: 401,
			connectionReplaced: 440
		},
		fetchLatestBaileysVersion: async () => ({
			version: [2, 3000, 0]
		}),
		makeCacheableSignalKeyStore: (keys: unknown) => keys,
		useMultiFileAuthState: async () => ({
			state: { creds: {}, keys: {} },
			saveCreds: noopAsync
		}),
		downloadMediaMessage: async () => Buffer.from('')
	}
})

mock.module(
	'@whiskeysockets/baileys/lib/Utils/logger',
	() => ({
		default: {
			level: 'silent',
			child: () => ({}),
			trace: () => {},
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {}
		}
	})
)

const { WhatsAppProvider } = await import('./provider')

describe('runtime status transitions', () => {
	let provider: InstanceType<typeof WhatsAppProvider>

	beforeEach(() => {
		provider = new WhatsAppProvider()
	})

	afterEach(async () => {
		await provider.shutdown()
	})

	test('initial status is disconnected with zero reconnects', () => {
		const status = provider.getStatus('default')
		expect(status.state).toBe('disconnected')
		expect(status.reconnectAttempts).toBe(0)
	})

	test('status has all expected fields', () => {
		const status = provider.getStatus('default')
		expect(status).toHaveProperty('state')
		expect(status).toHaveProperty('reconnectAttempts')
		// Optional fields should be undefined for unconnected account
		expect(status.connectedAt).toBeUndefined()
		expect(status.lastConnectedAt).toBeUndefined()
		expect(status.lastDisconnect).toBeUndefined()
		expect(status.lastMessageAt).toBeUndefined()
		expect(status.lastEventAt).toBeUndefined()
		expect(status.selfId).toBeUndefined()
	})

	test('different accounts have independent status', () => {
		const status1 = provider.getStatus('account1')
		const status2 = provider.getStatus('account2')
		expect(status1.state).toBe('disconnected')
		expect(status2.state).toBe('disconnected')
		expect(status1).not.toBe(status2) // Different objects
	})

	test('status state is one of the valid values', () => {
		const status = provider.getStatus('default')
		expect([
			'disconnected',
			'connecting',
			'connected',
			'error'
		]).toContain(status.state)
	})

	test('reconnectAttempts is always a number', () => {
		const status = provider.getStatus('default')
		expect(typeof status.reconnectAttempts).toBe('number')
		expect(status.reconnectAttempts).toBeGreaterThanOrEqual(
			0
		)
	})

	test('isReady returns false with reason for disconnected account', () => {
		const result = provider.isReady('default')
		expect(result.ok).toBe(false)
		expect(result.reason).toBe('account-not-found')
	})
})
