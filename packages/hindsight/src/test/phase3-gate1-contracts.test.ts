/**
 * Phase 3 Verification — Gate 1: Functional Contract
 *
 * Validates that all Phase 3 APIs exist, return expected schemas,
 * and produce deterministic ordering:
 *
 * 1. RecallOptions supports tokenBudget, scope, scopeMode
 * 2. locationRecord, locationFind, locationStats are callable with correct args
 * 3. Scoping helpers deriveScopeTagsFromContext, resolveScope produce deterministic results
 * 4. packContext returns expected PackResult schema
 * 5. All Phase 3 exports are accessible from index.ts
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
	getHdb,
	type TestHindsight
} from './setup'
import type { HindsightDatabase } from '../db'
import {
	// Location APIs
	normalizePath,
	detectLocationSignals,
	hasLocationSignals,
	// Scope APIs
	deriveScopeTagsFromContext,
	resolveScope,
	scopeMatches,
	DEFAULT_PROFILE,
	DEFAULT_PROJECT,
	type ScopeContext,
	// Context packing APIs
	packContext,
	generateFallbackGist,
	estimateTokens,
	type PackCandidate,
	type PackResult,
	// Gist APIs
	generateGist,
	generateGistWithLLM,
	EAGER_GIST_THRESHOLD,
	MAX_GIST_LENGTH
} from '../index'
import {
	locationRecord,
	locationFind,
	locationStats
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

let t: TestHindsight
let bankId: string

beforeEach(() => {
	t = createTestHindsight()
	bankId = createTestBank(t.hs, 'gate1-contracts')
})

afterEach(() => {
	t.cleanup()
})

describe('Gate 1: Functional Contract', () => {
	// ── 1. RecallOptions type surface ──────────────────────────────────────────

	describe('RecallOptions supports Phase 3 fields', () => {
		it('recall accepts tokenBudget option', async () => {
			await t.hs.retain(bankId, 'seed data', {
				facts: [
					{ content: 'The sky is blue', factType: 'world' }
				],
				consolidate: false
			})

			// Should not throw with tokenBudget
			const result = await t.hs.recall(
				bankId,
				'sky color',
				{
					tokenBudget: 2000,
					limit: 5
				}
			)
			expect(result).toBeDefined()
			expect(result.memories).toBeDefined()
		})

		it('recall accepts scope option', async () => {
			await t.hs.retain(bankId, 'seed data', {
				facts: [
					{
						content: 'Alice works at TechCorp',
						factType: 'world'
					}
				],
				consolidate: false
			})

			const result = await t.hs.recall(bankId, 'Alice', {
				scope: { profile: 'default', project: 'default' },
				limit: 5
			})
			expect(result).toBeDefined()
			expect(result.memories).toBeDefined()
		})

		it('recall accepts scopeMode option', async () => {
			await t.hs.retain(bankId, 'seed data', {
				facts: [
					{ content: 'Bob uses Python', factType: 'world' }
				],
				consolidate: false
			})

			const result = await t.hs.recall(bankId, 'Bob', {
				scope: { profile: 'default', project: 'default' },
				scopeMode: 'broad',
				limit: 5
			})
			expect(result).toBeDefined()
		})
	})

	// ── 2. Location APIs callable with correct args ───────────────────────────

	describe('locationRecord returns expected schema', () => {
		it('locationRecord creates path and returns void', async () => {
			const hdb = getHdb(t.hs)
			const memId = insertTestMemory(hdb, bankId)

			// Should not throw
			locationRecord(hdb, bankId, 'src/index.ts', {
				memoryId: memId
			})

			// Verify the path was created
			const hits = locationFind(hdb, bankId, {
				path: 'src/index.ts'
			})
			expect(hits.length).toBe(1)
		})

		it('locationRecord accepts scope parameters', async () => {
			const hdb = getHdb(t.hs)
			const memId = insertTestMemory(hdb, bankId)

			locationRecord(
				hdb,
				bankId,
				'src/app.ts',
				{ memoryId: memId },
				'alice',
				'proj-x'
			)

			const hits = locationFind(hdb, bankId, {
				path: 'src/app.ts',
				scope: { profile: 'alice', project: 'proj-x' }
			})
			expect(hits.length).toBe(1)
			expect(hits[0]!.profile).toBe('alice')
			expect(hits[0]!.project).toBe('proj-x')
		})
	})

	describe('locationFind returns LocationHit[] schema', () => {
		it('returns array with all required fields', () => {
			const hdb = getHdb(t.hs)
			const memId = insertTestMemory(hdb, bankId)
			locationRecord(hdb, bankId, 'src/utils.ts', {
				memoryId: memId
			})

			const hits = locationFind(hdb, bankId, {
				path: 'src/utils.ts'
			})
			expect(Array.isArray(hits)).toBe(true)
			expect(hits.length).toBe(1)

			const hit = hits[0]!
			expect(typeof hit.pathId).toBe('string')
			expect(typeof hit.rawPath).toBe('string')
			expect(typeof hit.normalizedPath).toBe('string')
			expect(typeof hit.profile).toBe('string')
			expect(typeof hit.project).toBe('string')
			expect(typeof hit.accessCount).toBe('number')
			expect(typeof hit.lastAccessedAt).toBe('number')
		})

		it('returns deterministic ordering for same input', () => {
			const hdb = getHdb(t.hs)
			for (let i = 0; i < 5; i++) {
				const memId = insertTestMemory(hdb, bankId)
				locationRecord(hdb, bankId, `src/file-${i}.ts`, {
					memoryId: memId
				})
			}

			const hits1 = locationFind(hdb, bankId, {})
			const hits2 = locationFind(hdb, bankId, {})
			expect(hits1.map(h => h.pathId)).toEqual(
				hits2.map(h => h.pathId)
			)
		})
	})

	describe('locationStats returns LocationStats | null schema', () => {
		it('returns null for unknown path', () => {
			const hdb = getHdb(t.hs)
			const stats = locationStats(
				hdb,
				bankId,
				'nonexistent.ts'
			)
			expect(stats).toBeNull()
		})

		it('returns LocationStats with all required fields', () => {
			const hdb = getHdb(t.hs)
			const memId = insertTestMemory(hdb, bankId)
			locationRecord(hdb, bankId, 'src/main.ts', {
				memoryId: memId
			})

			const stats = locationStats(
				hdb,
				bankId,
				'src/main.ts'
			)
			expect(stats).not.toBeNull()
			expect(typeof stats!.pathId).toBe('string')
			expect(typeof stats!.rawPath).toBe('string')
			expect(typeof stats!.normalizedPath).toBe('string')
			expect(typeof stats!.accessCount).toBe('number')
			expect(typeof stats!.associatedMemoryCount).toBe(
				'number'
			)
			expect(Array.isArray(stats!.topAssociations)).toBe(
				true
			)
		})
	})

	// ── 3. Hindsight class location methods ──────────────────────────────────

	describe('Hindsight class exposes location APIs', () => {
		it('hs.locationRecord is callable', async () => {
			const hdb = getHdb(t.hs)
			const memId = insertTestMemory(hdb, bankId)

			await t.hs.locationRecord(bankId, 'src/test.ts', {
				memoryId: memId
			})

			const hits = await t.hs.locationFind(bankId, {
				path: 'src/test.ts'
			})
			expect(hits.length).toBe(1)
		})

		it('hs.locationFind is callable', async () => {
			const hits = await t.hs.locationFind(bankId, {
				query: 'nonexistent'
			})
			expect(Array.isArray(hits)).toBe(true)
		})

		it('hs.locationStats is callable', async () => {
			const stats = await t.hs.locationStats(
				bankId,
				'nonexistent.ts'
			)
			expect(stats).toBeNull()
		})
	})

	// ── 4. Scoping helpers deterministic ─────────────────────────────────────

	describe('deriveScopeTagsFromContext deterministic', () => {
		it('same input produces same output across calls', () => {
			const ctx: ScopeContext = {
				profile: 'alice',
				project: 'proj-a',
				session: 's1'
			}
			const r1 = deriveScopeTagsFromContext(ctx)
			const r2 = deriveScopeTagsFromContext(ctx)
			expect(r1).toEqual(r2)
		})

		it('returns Scope type with profile, project, session', () => {
			const scope = deriveScopeTagsFromContext({
				profile: 'bob',
				project: 'proj-b'
			})
			expect(typeof scope.profile).toBe('string')
			expect(typeof scope.project).toBe('string')
			expect(scope.profile).toBe('bob')
			expect(scope.project).toBe('proj-b')
		})
	})

	describe('resolveScope deterministic', () => {
		it('same input produces same output across calls', () => {
			const explicit = {
				profile: 'alice',
				project: 'proj-a'
			}
			const ctx = {
				profile: 'fallback',
				project: 'fallback'
			}
			const r1 = resolveScope(explicit, ctx)
			const r2 = resolveScope(explicit, ctx)
			expect(r1).toEqual(r2)
		})
	})

	// ── 5. packContext returns expected PackResult schema ─────────────────────

	describe('packContext schema validation', () => {
		it('returns PackResult with all required fields', () => {
			const candidates: PackCandidate[] = [
				{
					id: 'a',
					content: 'Hello world',
					gist: 'Hello',
					score: 0.9
				},
				{
					id: 'b',
					content: 'Goodbye world',
					gist: 'Bye',
					score: 0.8
				}
			]
			const result: PackResult = packContext(
				candidates,
				2000
			)

			expect(Array.isArray(result.packed)).toBe(true)
			expect(typeof result.overflow).toBe('boolean')
			expect(typeof result.totalTokensUsed).toBe('number')
			expect(typeof result.budgetRemaining).toBe('number')
		})

		it('PackedMemory items have correct schema', () => {
			const candidates: PackCandidate[] = [
				{
					id: 'a',
					content: 'Hello world',
					gist: 'Hi',
					score: 0.9
				}
			]
			const result = packContext(candidates, 2000)
			const item = result.packed[0]!

			expect(typeof item.id).toBe('string')
			expect(typeof item.text).toBe('string')
			expect(
				item.mode === 'full' || item.mode === 'gist'
			).toBe(true)
			expect(typeof item.score).toBe('number')
			expect(typeof item.tokens).toBe('number')
		})
	})

	// ── 6. All Phase 3 exports accessible ────────────────────────────────────

	describe('Phase 3 exports exist', () => {
		it('location exports are defined', () => {
			expect(typeof normalizePath).toBe('function')
			expect(typeof detectLocationSignals).toBe('function')
			expect(typeof hasLocationSignals).toBe('function')
		})

		it('scope exports are defined', () => {
			expect(typeof deriveScopeTagsFromContext).toBe(
				'function'
			)
			expect(typeof resolveScope).toBe('function')
			expect(typeof scopeMatches).toBe('function')
			expect(typeof DEFAULT_PROFILE).toBe('string')
			expect(typeof DEFAULT_PROJECT).toBe('string')
		})

		it('context-pack exports are defined', () => {
			expect(typeof packContext).toBe('function')
			expect(typeof generateFallbackGist).toBe('function')
			expect(typeof estimateTokens).toBe('function')
		})

		it('gist exports are defined', () => {
			expect(typeof generateGist).toBe('function')
			expect(typeof generateGistWithLLM).toBe('function')
			expect(typeof EAGER_GIST_THRESHOLD).toBe('number')
			expect(typeof MAX_GIST_LENGTH).toBe('number')
		})

		it('constants have expected values', () => {
			expect(EAGER_GIST_THRESHOLD).toBe(2000)
			expect(MAX_GIST_LENGTH).toBe(280)
			expect(DEFAULT_PROFILE).toBe('default')
			expect(DEFAULT_PROJECT).toBe('default')
		})
	})
})
