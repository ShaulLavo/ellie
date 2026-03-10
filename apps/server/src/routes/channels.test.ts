import {
	describe,
	test,
	expect,
	beforeEach,
	afterEach
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Elysia } from 'elysia'
import { createChannelRoutes } from './channels'
import { upsertPairingRequest } from '../channels/providers/whatsapp/pairing-store'
import {
	addAllowFrom,
	readAllowFrom
} from '../channels/providers/whatsapp/allowfrom-store'
import type { ChannelManager } from '../channels/core'
import type { ChannelRuntimeStatus } from '../channels/core/types'

/**
 * Minimal mock ChannelManager that satisfies the route handlers.
 * Only uses a real dataDir for pairing/allowFrom store tests.
 */
function createMockManager(
	dataDir: string
): ChannelManager {
	const mockProvider = {
		id: 'whatsapp',
		displayName: 'WhatsApp',
		getStatus: (): ChannelRuntimeStatus => ({
			state: 'disconnected',
			reconnectAttempts: 0
		}),
		loginStart: async () => ({
			qr: 'mock',
			qrTerminal: 'mock'
		}),
		loginWait: async () => {
			throw new Error('No login in progress')
		},
		logout: async () => {},
		boot: async () => {},
		shutdown: async () => {},
		updateSettings: () => {},
		sendMessage: async () => ({}),
		sendMedia: async () => ({}),
		sendPoll: async () => ({}),
		sendReaction: async () => {},
		sendComposing: async () => {},
		isReady: () => ({ ok: false, reason: 'not-connected' })
	}

	return {
		dataDir,
		getProvider: (id: string) =>
			id === 'whatsapp' ? mockProvider : undefined,
		listProviders: () => [mockProvider],
		listSavedAccounts: () => ['default'],
		loadSettings: () => null,
		saveSettings: () => {},
		deleteAccountData: () => {},
		channelDir: (channelId: string) =>
			join(dataDir, 'channels', channelId),
		accountDir: (channelId: string, accountId: string) =>
			join(dataDir, 'channels', channelId, accountId)
	} as unknown as ChannelManager
}

describe('channel routes', () => {
	let dataDir: string
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let app: any

	beforeEach(() => {
		dataDir = mkdtempSync(
			join(tmpdir(), 'channels-route-test-')
		)
		const manager = createMockManager(dataDir)
		app = new Elysia().use(createChannelRoutes(manager))
	})

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true })
	})

	// ── Pairing routes ──────────────────────────────────────────────

	describe('pairing routes', () => {
		test('GET /pairing/list returns empty for new account', async () => {
			const res = await app.handle(
				new Request(
					'http://localhost/api/channels/whatsapp/pairing/list?accountId=default'
				)
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toEqual([])
		})

		test('POST /pairing/approve with invalid code returns 404', async () => {
			const res = await app.handle(
				new Request(
					'http://localhost/api/channels/whatsapp/pairing/approve',
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							accountId: 'default',
							code: 'INVALID'
						})
					}
				)
			)
			expect(res.status).toBe(404)
		})

		test('POST /pairing/approve with valid code succeeds', async () => {
			// Create a pairing request first
			const { code } = upsertPairingRequest({
				dataDir,
				accountId: 'default',
				senderId: '+15551234567'
			})

			const res = await app.handle(
				new Request(
					'http://localhost/api/channels/whatsapp/pairing/approve',
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							accountId: 'default',
							code
						})
					}
				)
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.senderId).toBe('+15551234567')

			// Verify sender was added to allowFrom store
			const allowed = readAllowFrom(dataDir, 'default')
			expect(allowed).toContain('+15551234567')
		})
	})

	// ── AllowFrom routes ────────────────────────────────────────────

	describe('allowFrom routes', () => {
		test('POST /allow/add normalizes and persists', async () => {
			const res = await app.handle(
				new Request(
					'http://localhost/api/channels/whatsapp/allow/add',
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							accountId: 'default',
							number: '+15551234567'
						})
					}
				)
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.ok).toBe(true)
			expect(body.normalized).toBe('+15551234567')

			// Verify persisted
			const allowed = readAllowFrom(dataDir, 'default')
			expect(allowed).toContain('+15551234567')
		})

		test('POST /allow/add with empty number returns 400', async () => {
			const res = await app.handle(
				new Request(
					'http://localhost/api/channels/whatsapp/allow/add',
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							accountId: 'default',
							number: ''
						})
					}
				)
			)
			expect(res.status).toBe(400)
		})

		test('POST /allow/remove removes entry', async () => {
			// Add first
			addAllowFrom(dataDir, 'default', '+15551234567')
			expect(readAllowFrom(dataDir, 'default')).toContain(
				'+15551234567'
			)

			// Remove
			const res = await app.handle(
				new Request(
					'http://localhost/api/channels/whatsapp/allow/remove',
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							accountId: 'default',
							number: '+15551234567'
						})
					}
				)
			)
			expect(res.status).toBe(200)
			expect(
				readAllowFrom(dataDir, 'default')
			).not.toContain('+15551234567')
		})

		test('GET /allow/list returns empty lists for new account', async () => {
			const res = await app.handle(
				new Request(
					'http://localhost/api/channels/whatsapp/allow/list?accountId=default'
				)
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.config).toEqual([])
			expect(body.runtime).toEqual([])
			expect(body.merged).toEqual([])
		})
	})

	// ── Settings validation ─────────────────────────────────────────

	describe('settings validation', () => {
		test('POST /login/start with invalid settings returns 400', async () => {
			const res = await app.handle(
				new Request(
					'http://localhost/api/channels/whatsapp/login/start',
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							accountId: 'default',
							settings: {
								dmPolicy: 'open',
								allowFrom: []
							}
						})
					}
				)
			)
			expect(res.status).toBe(400)
		})

		test('POST /login/start with valid settings succeeds', async () => {
			const res = await app.handle(
				new Request(
					'http://localhost/api/channels/whatsapp/login/start',
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							accountId: 'default',
							settings: {
								dmPolicy: 'pairing'
							}
						})
					}
				)
			)
			expect(res.status).toBe(200)
		})
	})

	// ── Channel listing ─────────────────────────────────────────────

	describe('channel listing', () => {
		test('GET / returns provider list', async () => {
			const res = await app.handle(
				new Request('http://localhost/api/channels')
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(Array.isArray(body)).toBe(true)
			expect(body[0].id).toBe('whatsapp')
			expect(body[0].displayName).toBe('WhatsApp')
		})

		test('GET /:channelId/status returns channel status', async () => {
			const res = await app.handle(
				new Request(
					'http://localhost/api/channels/whatsapp/status'
				)
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe('whatsapp')
			expect(body.accounts).toBeDefined()
		})

		test('GET /:channelId/status for unknown channel returns 404', async () => {
			const res = await app.handle(
				new Request(
					'http://localhost/api/channels/telegram/status'
				)
			)
			expect(res.status).toBe(404)
		})
	})
})
