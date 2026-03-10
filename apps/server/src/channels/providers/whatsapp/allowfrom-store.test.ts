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
	readAllowFrom,
	addAllowFrom,
	removeAllowFrom,
	mergedAllowFrom
} from './allowfrom-store'

describe('allowfrom-store', () => {
	let dataDir: string

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'allowfrom-test-'))
	})

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true })
	})

	const accountId = 'test-account'

	test('readAllowFrom returns empty for new account', () => {
		expect(readAllowFrom(dataDir, accountId)).toEqual([])
	})

	test('addAllowFrom persists entry', () => {
		addAllowFrom(dataDir, accountId, '+15551234567')
		const list = readAllowFrom(dataDir, accountId)
		expect(list).toEqual(['+15551234567'])
	})

	test('addAllowFrom deduplicates by normalized E.164', () => {
		addAllowFrom(dataDir, accountId, '+15551234567')
		addAllowFrom(dataDir, accountId, '15551234567')
		addAllowFrom(dataDir, accountId, '+1 (555) 123-4567')
		const list = readAllowFrom(dataDir, accountId)
		expect(list).toHaveLength(1)
	})

	test('removeAllowFrom removes entry', () => {
		addAllowFrom(dataDir, accountId, '+15551234567')
		addAllowFrom(dataDir, accountId, '+15559999999')
		removeAllowFrom(dataDir, accountId, '+15551234567')
		const list = readAllowFrom(dataDir, accountId)
		expect(list).toEqual(['+15559999999'])
	})

	test('removeAllowFrom is a no-op for unknown entry', () => {
		addAllowFrom(dataDir, accountId, '+15551234567')
		removeAllowFrom(dataDir, accountId, '+19999999999')
		const list = readAllowFrom(dataDir, accountId)
		expect(list).toEqual(['+15551234567'])
	})

	test('mergedAllowFrom combines config and store, deduped', () => {
		addAllowFrom(dataDir, accountId, '+15551234567')
		addAllowFrom(dataDir, accountId, '+15559999999')
		const result = mergedAllowFrom(
			['+15551234567', '+15550000000'],
			dataDir,
			accountId
		)
		expect(result).toHaveLength(3)
		expect(result).toContain('+15551234567')
		expect(result).toContain('+15550000000')
		expect(result).toContain('+15559999999')
	})

	test('mergedAllowFrom preserves wildcard', () => {
		const result = mergedAllowFrom(
			['*'],
			dataDir,
			accountId
		)
		expect(result).toContain('*')
	})
})
