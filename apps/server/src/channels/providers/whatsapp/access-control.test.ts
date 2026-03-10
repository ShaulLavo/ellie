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
import { checkInboundAccessControl } from './access-control'
import { addAllowFrom } from './allowfrom-store'
import type { WhatsAppSettings } from './provider'

function makeSettings(
	overrides: Partial<WhatsAppSettings> = {}
): WhatsAppSettings {
	return {
		selfChatMode: false,
		dmPolicy: 'pairing',
		allowFrom: [],
		groupPolicy: 'open',
		groupAllowFrom: [],
		groups: {},
		historyLimit: 50,
		sendReadReceipts: true,
		debounceMs: 0,
		mediaMaxMb: 50,
		...overrides
	}
}

function noopReply(): (text: string) => Promise<void> {
	return async () => {}
}

describe('access-control', () => {
	let dataDir: string

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'ac-test-'))
	})

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true })
	})

	const accountId = 'test-account'

	// ── DM: disabled ──────────────────────────────────────────────────

	test('dmPolicy: disabled blocks all DMs', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({ dmPolicy: 'disabled' }),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15551234567@s.whatsapp.net',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(false)
	})

	// ── DM: open ──────────────────────────────────────────────────────

	test('dmPolicy: open allows all DMs', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({ dmPolicy: 'open' }),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15551234567@s.whatsapp.net',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(true)
		expect(result.shouldMarkRead).toBe(true)
	})

	// ── DM: allowlist ─────────────────────────────────────────────────

	test('dmPolicy: allowlist blocks sender not in list', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				dmPolicy: 'allowlist',
				allowFrom: ['+15559999999']
			}),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15551234567@s.whatsapp.net',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(false)
	})

	test('dmPolicy: allowlist allows sender in list', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				dmPolicy: 'allowlist',
				allowFrom: ['+15551234567']
			}),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15551234567@s.whatsapp.net',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(true)
	})

	test('dmPolicy: allowlist with wildcard allows all', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				dmPolicy: 'allowlist',
				allowFrom: ['*']
			}),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15551234567@s.whatsapp.net',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(true)
	})

	// ── DM: pairing ───────────────────────────────────────────────────

	test('dmPolicy: pairing — unknown sender triggers pairing reply', async () => {
		const replies: string[] = []
		const result = await checkInboundAccessControl({
			settings: makeSettings({ dmPolicy: 'pairing' }),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15551234567@s.whatsapp.net',
			sendPairingReply: async text => {
				replies.push(text)
			},
			dataDir,
			accountId
		})
		expect(result.allowed).toBe(false)
		expect(replies).toHaveLength(1)
		expect(replies[0]).toContain('Pairing code:')
		expect(replies[0]).toContain('+15551234567')
	})

	test('dmPolicy: pairing — repeat unknown sender gets no duplicate reply', async () => {
		const replies: string[] = []
		const replyFn = async (text: string) => {
			replies.push(text)
		}
		const params = {
			settings: makeSettings({ dmPolicy: 'pairing' }),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15551234567@s.whatsapp.net',
			sendPairingReply: replyFn,
			dataDir,
			accountId
		}
		await checkInboundAccessControl(params)
		await checkInboundAccessControl(params)
		expect(replies).toHaveLength(1)
	})

	test('dmPolicy: pairing — approved sender is allowed', async () => {
		// Add sender to runtime allowFrom store
		addAllowFrom(dataDir, accountId, '+15551234567')

		const result = await checkInboundAccessControl({
			settings: makeSettings({ dmPolicy: 'pairing' }),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15551234567@s.whatsapp.net',
			sendPairingReply: noopReply(),
			dataDir,
			accountId
		})
		expect(result.allowed).toBe(true)
	})

	// ── Pairing grace period ──────────────────────────────────────────

	test('pairing: historical message suppresses reply', async () => {
		const connectedAt = Date.now()
		// Message from 5 minutes ago (well before connectedAt - 30s)
		const oldTimestamp = connectedAt - 5 * 60 * 1000

		const replies: string[] = []
		const result = await checkInboundAccessControl({
			settings: makeSettings({ dmPolicy: 'pairing' }),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: false,
			isFromMe: false,
			messageTimestampMs: oldTimestamp,
			connectedAtMs: connectedAt,
			remoteJid: '15551234567@s.whatsapp.net',
			sendPairingReply: async text => {
				replies.push(text)
			},
			dataDir,
			accountId
		})
		expect(result.allowed).toBe(false)
		expect(replies).toHaveLength(0) // No reply sent
	})

	test('pairing: live message sends reply', async () => {
		const connectedAt = Date.now() - 5000
		// Message from just now
		const recentTimestamp = Date.now()

		const replies: string[] = []
		const result = await checkInboundAccessControl({
			settings: makeSettings({ dmPolicy: 'pairing' }),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: false,
			isFromMe: false,
			messageTimestampMs: recentTimestamp,
			connectedAtMs: connectedAt,
			remoteJid: '15551234567@s.whatsapp.net',
			sendPairingReply: async text => {
				replies.push(text)
			},
			dataDir,
			accountId
		})
		expect(result.allowed).toBe(false)
		expect(replies).toHaveLength(1) // Reply sent
	})

	// ── Self-chat ─────────────────────────────────────────────────────

	test('self-chat: always allowed with selfChatMode flag', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				dmPolicy: 'allowlist',
				selfChatMode: true,
				allowFrom: []
			}),
			selfE164: '+15550000000',
			senderE164: '+15550000000',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15550000000@s.whatsapp.net',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(true)
		expect(result.isSelfChat).toBe(true)
		expect(result.shouldMarkRead).toBe(false)
	})

	test('self-chat: inferred from allowFrom containing own number', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				dmPolicy: 'allowlist',
				selfChatMode: false,
				allowFrom: ['+15550000000']
			}),
			selfE164: '+15550000000',
			senderE164: '+15550000000',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15550000000@s.whatsapp.net',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(true)
		expect(result.isSelfChat).toBe(true)
		expect(result.shouldMarkRead).toBe(false)
	})

	// ── Group: disabled ───────────────────────────────────────────────

	test('groupPolicy: disabled blocks all group messages', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({ groupPolicy: 'disabled' }),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: true,
			isFromMe: false,
			remoteJid: '12345-67890@g.us',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(false)
	})

	// ── Group: open ───────────────────────────────────────────────────

	test('groupPolicy: open allows all group messages', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({ groupPolicy: 'open' }),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: true,
			isFromMe: false,
			remoteJid: '12345-67890@g.us',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(true)
		expect(result.shouldMarkRead).toBe(true)
	})

	// ── Group: allowlist ──────────────────────────────────────────────

	test('groupPolicy: allowlist without groupAllowFrom blocks', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				groupPolicy: 'allowlist',
				groupAllowFrom: []
			}),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: true,
			isFromMe: false,
			remoteJid: '12345-67890@g.us',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(false)
	})

	test('groupPolicy: allowlist with wildcard allows all', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				groupPolicy: 'allowlist',
				groupAllowFrom: ['*']
			}),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: true,
			isFromMe: false,
			remoteJid: '12345-67890@g.us',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(true)
	})

	test('groupPolicy: allowlist allows matching sender', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				groupPolicy: 'allowlist',
				groupAllowFrom: ['+15551234567']
			}),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: true,
			isFromMe: false,
			remoteJid: '12345-67890@g.us',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(true)
	})

	test('groupPolicy: allowlist blocks non-matching sender', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				groupPolicy: 'allowlist',
				groupAllowFrom: ['+15559999999']
			}),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: true,
			isFromMe: false,
			remoteJid: '12345-67890@g.us',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(false)
	})

	// ── Echo suppression ──────────────────────────────────────────────

	test('outgoing echo on non-self account is blocked', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({ dmPolicy: 'open' }),
			selfE164: '+15550000000',
			senderE164: '+15559999999',
			isGroup: false,
			isFromMe: true,
			remoteJid: '15559999999@s.whatsapp.net',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(false)
	})

	// ── DM edge cases (Phase 7, Task 1a) ─────────────────────────────

	test('dmPolicy: pairing — no senderE164 blocks silently (no reply)', async () => {
		const replies: string[] = []
		const result = await checkInboundAccessControl({
			settings: makeSettings({ dmPolicy: 'pairing' }),
			selfE164: '+15550000000',
			senderE164: null,
			isGroup: false,
			isFromMe: false,
			remoteJid: '118696035008721@lid',
			sendPairingReply: async text => {
				replies.push(text)
			},
			dataDir,
			accountId
		})
		expect(result.allowed).toBe(false)
		expect(replies).toHaveLength(0) // LID-only sender can't get a pairing code
	})

	test('dmPolicy: allowlist — senderE164 with different formatting still matches', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				dmPolicy: 'allowlist',
				allowFrom: ['+1 555 123 4567']
			}),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15551234567@s.whatsapp.net',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(true)
	})

	test('dmPolicy: open — self-chat flag still detected when sender matches self', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				dmPolicy: 'open',
				selfChatMode: true
			}),
			selfE164: '+15550000000',
			senderE164: '+15550000000',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15550000000@s.whatsapp.net',
			sendPairingReply: noopReply()
		})
		// dmPolicy: open allows before self-chat check, so allowed is true
		expect(result.allowed).toBe(true)
	})

	test('fromMe message on self-chat account is allowed', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				dmPolicy: 'allowlist',
				selfChatMode: true,
				allowFrom: []
			}),
			selfE164: '+15550000000',
			senderE164: '+15550000000',
			isGroup: false,
			isFromMe: true,
			remoteJid: '15550000000@s.whatsapp.net',
			sendPairingReply: noopReply()
		})
		// isFromMe + same phone as self → echo suppression skipped, self-chat detected
		expect(result.allowed).toBe(true)
		expect(result.isSelfChat).toBe(true)
	})

	// ── Group policy edge cases (Phase 7, Task 1b) ───────────────────

	test('groupPolicy: allowlist — sender without E.164 (LID-only) is blocked', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				groupPolicy: 'allowlist',
				groupAllowFrom: ['+15551234567']
			}),
			selfE164: '+15550000000',
			senderE164: null,
			isGroup: true,
			isFromMe: false,
			remoteJid: '12345-67890@g.us',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(false)
	})

	test('groupPolicy: allowlist — E.164 normalization matches non-normalized entry', async () => {
		const result = await checkInboundAccessControl({
			settings: makeSettings({
				groupPolicy: 'allowlist',
				groupAllowFrom: ['1 555 123 4567']
			}),
			selfE164: '+15550000000',
			senderE164: '+15551234567',
			isGroup: true,
			isFromMe: false,
			remoteJid: '12345-67890@g.us',
			sendPairingReply: noopReply()
		})
		expect(result.allowed).toBe(true)
	})

	// ── Pairing + AllowFrom Store Integration (Phase 7, Task 1c) ─────

	test('pairing: approved sender persists across calls', async () => {
		const replies: string[] = []
		const replyFn = async (text: string) => {
			replies.push(text)
		}

		// 1. First call: unknown → pairing reply
		await checkInboundAccessControl({
			settings: makeSettings({ dmPolicy: 'pairing' }),
			selfE164: '+15550000000',
			senderE164: '+15559876543',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15559876543@s.whatsapp.net',
			sendPairingReply: replyFn,
			dataDir,
			accountId
		})
		expect(replies).toHaveLength(1)

		// 2. Add to allowFrom store
		addAllowFrom(dataDir, accountId, '+15559876543')

		// 3. Second call: same sender → allowed
		const result2 = await checkInboundAccessControl({
			settings: makeSettings({ dmPolicy: 'pairing' }),
			selfE164: '+15550000000',
			senderE164: '+15559876543',
			isGroup: false,
			isFromMe: false,
			remoteJid: '15559876543@s.whatsapp.net',
			sendPairingReply: replyFn,
			dataDir,
			accountId
		})
		expect(result2.allowed).toBe(true)
	})
})
