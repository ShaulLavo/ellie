/**
 * Tests for the location module: path normalization, signal detection,
 * location recording, path resolution, and boost computation.
 */

import {
	describe,
	it,
	expect,
	beforeEach,
	afterEach
} from 'bun:test'
import { ulid } from '@ellie/utils'
import {
	createTestHindsight,
	createTestBank,
	getHdb
} from './setup'
import type { TestHindsight } from './setup'
import type { HindsightDatabase } from '../db'
import {
	normalizePath,
	detectLocationSignals,
	hasLocationSignals,
	locationRecord,
	locationFind,
	locationStats,
	resolveSignalsToPaths,
	computeLocationBoost,
	getMaxStrengthForPaths
} from '../location'

/** Insert a minimal memory row to satisfy FK constraints. */
function insertTestMemory(
	hdb: HindsightDatabase,
	bid: string,
	memId?: string
): string {
	const id = memId ?? ulid()
	const now = Date.now()
	hdb.db
		.insert(hdb.schema.memoryUnits)
		.values({
			id,
			bankId: bid,
			content: `Test memory ${id}`,
			factType: 'world',
			confidence: 1.0,
			createdAt: now,
			updatedAt: now
		})
		.run()
	return id
}

let test: TestHindsight
let bankId: string

beforeEach(() => {
	test = createTestHindsight()
	bankId = createTestBank(test.hs, 'location-test')
})

afterEach(() => {
	test.cleanup()
})

// ── Path normalization ──────────────────────────────────────────────────────

describe('normalizePath', () => {
	it('trims whitespace', () => {
		expect(normalizePath('  src/foo.ts  ')).toBe(
			'src/foo.ts'
		)
	})

	it('replaces backslashes with forward slashes', () => {
		expect(normalizePath('src\\lib\\foo.ts')).toBe(
			'src/lib/foo.ts'
		)
	})

	it('collapses repeated slashes', () => {
		expect(normalizePath('src//lib///foo.ts')).toBe(
			'src/lib/foo.ts'
		)
	})

	it('removes trailing slash except root', () => {
		expect(normalizePath('src/lib/')).toBe('src/lib')
		expect(normalizePath('/')).toBe('/')
	})

	it('lowercases the result', () => {
		expect(normalizePath('Src/Lib/Foo.TS')).toBe(
			'src/lib/foo.ts'
		)
	})

	it('handles Windows-style paths', () => {
		expect(
			normalizePath('C:\\Users\\dev\\project\\src\\main.ts')
		).toBe('c:/users/dev/project/src/main.ts')
	})

	it('handles root path', () => {
		expect(normalizePath('/')).toBe('/')
	})

	it('handles empty-ish input', () => {
		expect(normalizePath('  ')).toBe('')
	})
})

// ── Query signal detection ──────────────────────────────────────────────────

describe('detectLocationSignals', () => {
	it('detects absolute file paths', () => {
		const signals = detectLocationSignals(
			'What does /src/lib/utils.ts do?'
		)
		expect(signals).toContain('/src/lib/utils.ts')
	})

	it('detects relative file paths', () => {
		const signals = detectLocationSignals(
			'Look at ./lib/config.ts'
		)
		expect(signals).toContain('./lib/config.ts')
	})

	it('detects module-like path tokens', () => {
		const signals = detectLocationSignals(
			'Check src/components/Button.tsx'
		)
		expect(signals.length).toBeGreaterThan(0)
		expect(
			signals.some(s => s.includes('src/components'))
		).toBe(true)
	})

	it('detects dot-separated module tokens', () => {
		const signals = detectLocationSignals(
			'The utils.logger module is broken'
		)
		expect(signals).toContain('utils.logger')
	})

	it('does not detect version numbers as modules', () => {
		const signals = detectLocationSignals(
			'We use version 1.2.3'
		)
		expect(signals.length).toBe(0)
	})

	it('does not detect sentence boundaries as modules', () => {
		const signals = detectLocationSignals(
			'Something happened. Then more happened.'
		)
		expect(signals.length).toBe(0)
	})

	it('returns empty for queries without location signals', () => {
		const signals = detectLocationSignals(
			"What is Peter's favorite color?"
		)
		expect(signals).toEqual([])
	})
})

describe('hasLocationSignals', () => {
	it('returns true when signals present', () => {
		expect(hasLocationSignals('Check src/foo/bar.ts')).toBe(
			true
		)
	})

	it('returns false when no signals', () => {
		expect(hasLocationSignals('What is the weather?')).toBe(
			false
		)
	})
})

// ── Location record + find + stats ──────────────────────────────────────────

describe('locationRecord', () => {
	it('creates a new path entry', () => {
		const hdb = getHdb(test.hs)
		const memId = insertTestMemory(hdb, bankId)

		locationRecord(hdb, bankId, 'src/foo.ts', {
			memoryId: memId
		})

		const hits = locationFind(hdb, bankId, {
			path: 'src/foo.ts'
		})
		expect(hits.length).toBe(1)
		expect(hits[0]!.normalizedPath).toBe('src/foo.ts')
		expect(hits[0]!.accessCount).toBe(1)
	})

	it('increments access count on repeated access', () => {
		const hdb = getHdb(test.hs)
		const mem1 = insertTestMemory(hdb, bankId)
		const mem2 = insertTestMemory(hdb, bankId)

		locationRecord(hdb, bankId, 'src/foo.ts', {
			memoryId: mem1
		})
		locationRecord(hdb, bankId, 'src/foo.ts', {
			memoryId: mem2
		})

		const hits = locationFind(hdb, bankId, {
			path: 'src/foo.ts'
		})
		expect(hits.length).toBe(1)
		expect(hits[0]!.accessCount).toBe(2)
	})

	it('normalizes paths on record', () => {
		const hdb = getHdb(test.hs)
		const memId = insertTestMemory(hdb, bankId)

		locationRecord(hdb, bankId, 'Src\\Foo.TS', {
			memoryId: memId
		})

		const hits = locationFind(hdb, bankId, {
			path: 'src/foo.ts'
		})
		expect(hits.length).toBe(1)
	})

	it('creates co-access associations within a session', () => {
		const hdb = getHdb(test.hs)
		const mem1 = insertTestMemory(hdb, bankId)
		const mem2 = insertTestMemory(hdb, bankId)

		locationRecord(hdb, bankId, 'src/a.ts', {
			memoryId: mem1,
			session: 'sess-1'
		})
		locationRecord(hdb, bankId, 'src/b.ts', {
			memoryId: mem2,
			session: 'sess-1'
		})

		const stats = locationStats(hdb, bankId, 'src/a.ts')
		expect(stats).not.toBeNull()
		expect(
			stats!.topAssociations.length
		).toBeGreaterThanOrEqual(1)
		expect(stats!.topAssociations[0]!.coAccessCount).toBe(1)
	})
})

describe('locationFind', () => {
	it('finds paths by exact match', () => {
		const hdb = getHdb(test.hs)
		const memId = insertTestMemory(hdb, bankId)
		locationRecord(hdb, bankId, 'src/utils.ts', {
			memoryId: memId
		})

		const hits = locationFind(hdb, bankId, {
			path: 'src/utils.ts'
		})
		expect(hits.length).toBe(1)
	})

	it('falls back to signal detection from query', () => {
		const hdb = getHdb(test.hs)
		const memId = insertTestMemory(hdb, bankId)
		locationRecord(hdb, bankId, 'src/utils/logger.ts', {
			memoryId: memId
		})

		const hits = locationFind(hdb, bankId, {
			query: 'Check src/utils/logger.ts for bugs'
		})
		expect(hits.length).toBe(1)
	})

	it('respects scope filtering', () => {
		const hdb = getHdb(test.hs)
		const mem1 = insertTestMemory(hdb, bankId)
		const mem2 = insertTestMemory(hdb, bankId)
		locationRecord(
			hdb,
			bankId,
			'src/foo.ts',
			{ memoryId: mem1 },
			'alice',
			'proj-a'
		)
		locationRecord(
			hdb,
			bankId,
			'src/foo.ts',
			{ memoryId: mem2 },
			'bob',
			'proj-b'
		)

		const hitsAlice = locationFind(hdb, bankId, {
			path: 'src/foo.ts',
			scope: { profile: 'alice', project: 'proj-a' }
		})
		expect(hitsAlice.length).toBe(1)
		expect(hitsAlice[0]!.profile).toBe('alice')
	})
})

describe('locationStats', () => {
	it('returns null for unknown path', () => {
		const hdb = getHdb(test.hs)
		const stats = locationStats(
			hdb,
			bankId,
			'nonexistent.ts'
		)
		expect(stats).toBeNull()
	})

	it('returns stats for known path', () => {
		const hdb = getHdb(test.hs)
		const mem1 = insertTestMemory(hdb, bankId)
		const mem2 = insertTestMemory(hdb, bankId)
		locationRecord(hdb, bankId, 'src/main.ts', {
			memoryId: mem1
		})
		locationRecord(hdb, bankId, 'src/main.ts', {
			memoryId: mem2
		})

		const stats = locationStats(hdb, bankId, 'src/main.ts')
		expect(stats).not.toBeNull()
		expect(stats!.accessCount).toBe(2)
		expect(stats!.associatedMemoryCount).toBe(2)
	})
})

// ── Signal resolution to paths ──────────────────────────────────────────────

describe('resolveSignalsToPaths', () => {
	it('resolves exact match signals', () => {
		const hdb = getHdb(test.hs)
		const memId = insertTestMemory(hdb, bankId)
		locationRecord(hdb, bankId, 'src/foo.ts', {
			memoryId: memId
		})

		const map = resolveSignalsToPaths(hdb, bankId, [
			'src/foo.ts'
		])
		expect(map.size).toBe(1)
		expect(map.get('src/foo.ts')!.length).toBe(1)
	})

	it('resolves suffix matches', () => {
		const hdb = getHdb(test.hs)
		const memId = insertTestMemory(hdb, bankId)
		locationRecord(
			hdb,
			bankId,
			'/home/user/project/src/utils.ts',
			{ memoryId: memId }
		)

		const map = resolveSignalsToPaths(hdb, bankId, [
			'src/utils.ts'
		])
		expect(map.size).toBe(1)
	})

	it('returns empty for unresolvable signals', () => {
		const hdb = getHdb(test.hs)
		const map = resolveSignalsToPaths(hdb, bankId, [
			'nonexistent/path.ts'
		])
		expect(map.size).toBe(0)
	})
})

// ── Boost computation ───────────────────────────────────────────────────────

describe('computeLocationBoost', () => {
	it('returns 0 when no query paths provided', () => {
		const hdb = getHdb(test.hs)
		const boost = computeLocationBoost(
			hdb,
			bankId,
			'mem-1',
			new Set(),
			0,
			Date.now()
		)
		expect(boost).toBe(0)
	})

	it('returns 0 when memory has no location associations', () => {
		const hdb = getHdb(test.hs)
		const mem1 = insertTestMemory(hdb, bankId)
		const mem2 = insertTestMemory(hdb, bankId)
		locationRecord(hdb, bankId, 'src/foo.ts', {
			memoryId: mem1
		})

		const hits = locationFind(hdb, bankId, {
			path: 'src/foo.ts'
		})
		const pathId = hits[0]!.pathId

		// mem2 has no associations
		const boost = computeLocationBoost(
			hdb,
			bankId,
			mem2,
			new Set([pathId]),
			0,
			Date.now()
		)
		expect(boost).toBe(0)
	})

	it('returns direct path boost when memory shares a query path', () => {
		const hdb = getHdb(test.hs)
		const memId = insertTestMemory(hdb, bankId)
		locationRecord(hdb, bankId, 'src/foo.ts', {
			memoryId: memId
		})

		const hits = locationFind(hdb, bankId, {
			path: 'src/foo.ts'
		})
		const pathId = hits[0]!.pathId

		const boost = computeLocationBoost(
			hdb,
			bankId,
			memId,
			new Set([pathId]),
			0,
			Date.now()
		)
		// Should have at least directPathBoost (0.12) + familiarityBoost
		expect(boost).toBeGreaterThan(0.1)
	})
})

describe('getMaxStrengthForPaths', () => {
	it('returns 0 when no associations exist', () => {
		const hdb = getHdb(test.hs)
		expect(
			getMaxStrengthForPaths(hdb, bankId, new Set())
		).toBe(0)
		expect(
			getMaxStrengthForPaths(
				hdb,
				bankId,
				new Set(['nonexistent'])
			)
		).toBe(0)
	})
})
