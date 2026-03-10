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
import {
	upsertPairingRequest,
	approvePairingCode,
	listPairingRequests
} from './pairing-store'

describe('pairing-store', () => {
	let dataDir: string

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'pairing-test-'))
	})

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true })
	})

	const accountId = 'test-account'

	test('upsert creates a new request with 8-char code', () => {
		const result = upsertPairingRequest({
			dataDir,
			accountId,
			senderId: '+15551234567'
		})
		expect(result.created).toBe(true)
		expect(result.code).toHaveLength(8)
		// Code should only contain non-ambiguous chars
		expect(result.code).toMatch(
			/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/
		)
	})

	test('upsert returns created: false for repeat sender', () => {
		const first = upsertPairingRequest({
			dataDir,
			accountId,
			senderId: '+15551234567'
		})
		const second = upsertPairingRequest({
			dataDir,
			accountId,
			senderId: '+15551234567'
		})
		expect(first.created).toBe(true)
		expect(second.created).toBe(false)
		expect(second.code).toBe(first.code)
	})

	test('upsert preserves meta on repeat', () => {
		upsertPairingRequest({
			dataDir,
			accountId,
			senderId: '+15551234567',
			meta: { name: 'Alice' }
		})
		upsertPairingRequest({
			dataDir,
			accountId,
			senderId: '+15551234567',
			meta: { name: 'Alice Updated' }
		})
		const list = listPairingRequests({ dataDir, accountId })
		expect(list).toHaveLength(1)
		expect(list[0].meta?.name).toBe('Alice Updated')
	})

	test('evicts oldest when at max capacity (3)', () => {
		upsertPairingRequest({
			dataDir,
			accountId,
			senderId: '+11111111111'
		})
		upsertPairingRequest({
			dataDir,
			accountId,
			senderId: '+12222222222'
		})
		upsertPairingRequest({
			dataDir,
			accountId,
			senderId: '+13333333333'
		})
		// 4th should evict the 1st
		upsertPairingRequest({
			dataDir,
			accountId,
			senderId: '+14444444444'
		})
		const list = listPairingRequests({ dataDir, accountId })
		expect(list).toHaveLength(3)
		expect(list.map(r => r.id)).not.toContain(
			'+11111111111'
		)
		expect(list.map(r => r.id)).toContain('+14444444444')
	})

	test('approve removes request and returns sender id', () => {
		const { code } = upsertPairingRequest({
			dataDir,
			accountId,
			senderId: '+15551234567'
		})
		const result = approvePairingCode({
			dataDir,
			accountId,
			code
		})
		expect(result).toEqual({ id: '+15551234567' })
		// Should be gone from list
		const list = listPairingRequests({ dataDir, accountId })
		expect(list).toHaveLength(0)
	})

	test('approve is case-insensitive', () => {
		const { code } = upsertPairingRequest({
			dataDir,
			accountId,
			senderId: '+15551234567'
		})
		const result = approvePairingCode({
			dataDir,
			accountId,
			code: code.toLowerCase()
		})
		expect(result).not.toBeNull()
	})

	test('approve returns null for unknown code', () => {
		const result = approvePairingCode({
			dataDir,
			accountId,
			code: 'ZZZZZZZZ'
		})
		expect(result).toBeNull()
	})

	test('listPairingRequests returns empty for new account', () => {
		const list = listPairingRequests({ dataDir, accountId })
		expect(list).toEqual([])
	})

	test('unique codes across requests', () => {
		const codes = new Set<string>()
		for (let i = 0; i < 10; i++) {
			// Each iteration uses a fresh account to avoid eviction
			const { code } = upsertPairingRequest({
				dataDir,
				accountId: `acct-${i}`,
				senderId: `+1555000${String(i).padStart(4, '0')}`
			})
			codes.add(code)
		}
		// All codes should be unique (highly probable with 8-char random codes)
		expect(codes.size).toBe(10)
	})
})
