import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach,
	mock
} from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

// Mock Baileys before importing provider — the installed version
// is missing useMultiFileAuthState from its barrel export (packaging bug).
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

// Also mock the logger import since it may pull from Baileys internals
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

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'wa-provider-test-'))
}

describe('WhatsAppProvider', () => {
	let dir: string
	let provider: InstanceType<typeof WhatsAppProvider>

	beforeEach(() => {
		dir = createTempDir()
		provider = new WhatsAppProvider()
	})

	afterEach(async () => {
		await provider.shutdown()
		rmSync(dir, { recursive: true, force: true })
	})

	test('has correct id and displayName', () => {
		expect(provider.id).toBe('whatsapp')
		expect(provider.displayName).toBe('WhatsApp')
	})

	test('getStatus returns disconnected with reconnectAttempts for unknown account', () => {
		const status = provider.getStatus('default')
		expect(status.state).toBe('disconnected')
		expect(status.reconnectAttempts).toBe(0)
	})

	test('shutdown is idempotent', async () => {
		await provider.shutdown()
		await provider.shutdown()
	})

	test('loginWait throws for unknown account', async () => {
		expect(
			provider.loginWait('nonexistent')
		).rejects.toThrow('No login in progress')
	})

	test('logout is safe for unknown account', async () => {
		await provider.logout('nonexistent')
	})

	test('updateSettings is safe for unknown account', () => {
		provider.updateSettings('nonexistent', {
			selfChatMode: true,
			dmPolicy: 'allowlist',
			allowFrom: [],
			groupPolicy: 'disabled'
		})
	})

	test('sendMessage throws when not connected', async () => {
		expect(
			provider.sendMessage(
				{
					channelId: 'whatsapp',
					accountId: 'default',
					conversationId: '123@s.whatsapp.net'
				},
				'hello'
			)
		).rejects.toThrow('not connected')
	})

	test('sendMedia throws when not connected', async () => {
		expect(
			provider.sendMedia(
				{
					channelId: 'whatsapp',
					accountId: 'default',
					conversationId: '123@s.whatsapp.net'
				},
				'caption',
				{
					buffer: Buffer.from(''),
					mimetype: 'image/png'
				}
			)
		).rejects.toThrow('not connected')
	})

	test('sendPoll throws when not connected', async () => {
		expect(
			provider.sendPoll(
				{
					channelId: 'whatsapp',
					accountId: 'default',
					conversationId: '123@s.whatsapp.net'
				},
				{
					question: 'Test?',
					options: ['A', 'B']
				}
			)
		).rejects.toThrow('not connected')
	})

	test('sendReaction throws when not connected', async () => {
		expect(
			provider.sendReaction(
				{
					channelId: 'whatsapp',
					accountId: 'default',
					conversationId: '123@s.whatsapp.net'
				},
				'msg-1',
				'👍'
			)
		).rejects.toThrow('not connected')
	})

	test('sendComposing is safe when not connected', async () => {
		// Should not throw — just silently returns
		await provider.sendComposing({
			channelId: 'whatsapp',
			accountId: 'default',
			conversationId: '123@s.whatsapp.net'
		})
	})

	test('isReady returns false for unknown account', () => {
		const result = provider.isReady('nonexistent')
		expect(result.ok).toBe(false)
		expect(result.reason).toBe('account-not-found')
	})

	// ── Phase 7: Additional provider tests ───────────────────────────

	test('getStatus returns disconnected state for unknown account', () => {
		const status = provider.getStatus('nonexistent')
		expect(status.state).toBe('disconnected')
		expect(status.reconnectAttempts).toBe(0)
		expect(status.connectedAt).toBeUndefined()
	})

	test('sendMessage with different account throws', async () => {
		expect(
			provider.sendMessage(
				{
					channelId: 'whatsapp',
					accountId: 'other-account',
					conversationId: '123@s.whatsapp.net'
				},
				'hello'
			)
		).rejects.toThrow('not connected')
	})

	test('sendMedia with audio as voice note throws when not connected', async () => {
		expect(
			provider.sendMedia(
				{
					channelId: 'whatsapp',
					accountId: 'default',
					conversationId: '123@s.whatsapp.net'
				},
				'',
				{
					buffer: Buffer.from('audio-data'),
					mimetype: 'audio/ogg; codecs=opus'
				}
			)
		).rejects.toThrow('not connected')
	})

	test('sendPoll with empty options throws when not connected', async () => {
		expect(
			provider.sendPoll(
				{
					channelId: 'whatsapp',
					accountId: 'default',
					conversationId: '123@s.whatsapp.net'
				},
				{
					question: 'Test?',
					options: []
				}
			)
		).rejects.toThrow('not connected')
	})

	test('sendReaction with emoji throws when not connected', async () => {
		expect(
			provider.sendReaction(
				{
					channelId: 'whatsapp',
					accountId: 'default',
					conversationId: '123@s.whatsapp.net'
				},
				'msg-id-123',
				'❤️',
				true // fromMe
			)
		).rejects.toThrow('not connected')
	})

	test('updateSettings with full settings object is safe', () => {
		provider.updateSettings('default', {
			selfChatMode: true,
			dmPolicy: 'open',
			allowFrom: ['*'],
			groupPolicy: 'open',
			groupAllowFrom: ['*'],
			sendReadReceipts: false,
			debounceMs: 1000,
			mediaMaxMb: 25,
			historyLimit: 100
		})
		// Should not throw
	})
})
