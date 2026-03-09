import {
	describe,
	expect,
	test,
	beforeEach,
	afterEach,
	mock
} from 'bun:test'
import { WhatsAppProvider } from './provider'
import type { ChannelManager } from '../../core/manager'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'wa-provider-test-'))
}

describe('WhatsAppProvider', () => {
	let dir: string
	let provider: WhatsAppProvider

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

	test('getStatus returns disconnected for unknown account', () => {
		const status = provider.getStatus('default')
		expect(status.state).toBe('disconnected')
	})

	test('shutdown is idempotent', async () => {
		await provider.shutdown()
		await provider.shutdown()
		// No error
	})

	test('loginWait throws for unknown account', async () => {
		expect(
			provider.loginWait('nonexistent')
		).rejects.toThrow('No login in progress')
	})

	test('logout is safe for unknown account', async () => {
		// Should not throw for non-existent account
		await provider.logout('nonexistent')
	})

	test('updateSettings is safe for unknown account', () => {
		// Should not throw
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
})
