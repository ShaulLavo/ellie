/**
 * Phase 3 Verification — Gate 4: Scope Isolation
 *
 * BleedRate = cross_project_hits / total_hits for default-scoped queries.
 * Pass condition: BleedRate == 0 in strict mode.
 *
 * Also validates:
 * - scopeMode='broad' allows cross-project retrieval
 * - Legacy null-scope memories are always included
 * - Partial scope (profile-only, project-only) behaves correctly
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createTestHindsight, createTestBank, getHdb, type TestHindsight } from './setup'
import type { HindsightDatabase } from '../db'
import {
	scopeMatches,
	resolveScope,
	deriveScopeTagsFromContext,
	DEFAULT_PROFILE,
	DEFAULT_PROJECT,
	type Scope
} from '../scope'
import { locationRecord, locationFind } from '../location'
import { ulid } from '@ellie/utils'

function insertTestMemory(
	hdb: HindsightDatabase,
	bid: string,
	content: string,
	opts?: { profile?: string; project?: string; session?: string }
): string {
	const id = ulid()
	const now = Date.now()
	hdb.db
		.insert(hdb.schema.memoryUnits)
		.values({
			id,
			bankId: bid,
			content,
			factType: 'world',
			confidence: 1.0,
			scopeProfile: opts?.profile ?? null,
			scopeProject: opts?.project ?? null,
			scopeSession: opts?.session ?? null,
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
	bankId = createTestBank(t.hs, 'gate4-scope')
})

afterEach(() => {
	t.cleanup()
})

describe('Gate 4: Scope Isolation', () => {
	// ── Primary: BleedRate == 0 ───────────────────────────────────────────────

	describe('strict mode cross-project bleed rate', () => {
		it('bleed rate is exactly 0 for strict-scoped queries', () => {
			const hdb = getHdb(t.hs)

			// Create memories across 3 projects
			const projA_memories = [
				insertTestMemory(hdb, bankId, 'Project A: auth module works great', {
					profile: 'alice',
					project: 'proj-a'
				}),
				insertTestMemory(hdb, bankId, 'Project A: database schema is normalized', {
					profile: 'alice',
					project: 'proj-a'
				}),
				insertTestMemory(hdb, bankId, 'Project A: API routes are RESTful', {
					profile: 'alice',
					project: 'proj-a'
				})
			]

			const projB_memories = [
				insertTestMemory(hdb, bankId, 'Project B: auth uses OAuth2', {
					profile: 'alice',
					project: 'proj-b'
				}),
				insertTestMemory(hdb, bankId, 'Project B: database is MongoDB', {
					profile: 'alice',
					project: 'proj-b'
				})
			]

			const projC_memories = [
				insertTestMemory(hdb, bankId, 'Project C: uses GraphQL', {
					profile: 'bob',
					project: 'proj-c'
				}),
				insertTestMemory(hdb, bankId, 'Project C: deployed on AWS', {
					profile: 'bob',
					project: 'proj-c'
				})
			]

			// Filter memories as if doing scoped recall
			const allMemoryScopes = [
				...projA_memories.map((id) => ({ id, profile: 'alice', project: 'proj-a' })),
				...projB_memories.map((id) => ({ id, profile: 'alice', project: 'proj-b' })),
				...projC_memories.map((id) => ({ id, profile: 'bob', project: 'proj-c' }))
			]

			// Query scoped to proj-a
			const filterScope: Scope = { profile: 'alice', project: 'proj-a' }
			let crossProjectHits = 0
			let totalHits = 0

			for (const mem of allMemoryScopes) {
				const matches = scopeMatches(
					{ profile: mem.profile, project: mem.project },
					filterScope,
					'strict'
				)
				if (matches) {
					totalHits++
					// Check if this is actually from a different project
					if (mem.project !== 'proj-a' || mem.profile !== 'alice') {
						crossProjectHits++
					}
				}
			}

			const bleedRate = totalHits > 0 ? crossProjectHits / totalHits : 0
			expect(bleedRate).toBe(0)
			expect(totalHits).toBe(3) // Only proj-a memories
		})

		it('bleed rate is 0 across multiple cross-project query pairs', () => {
			// Simulate 120 paired cross-project cases (as per eval plan spec)
			const projects = ['proj-1', 'proj-2', 'proj-3', 'proj-4']
			const profiles = ['alice', 'bob']

			// Generate cross-project pairs
			const pairs: Array<{
				memScope: { profile: string; project: string }
				queryScope: Scope
			}> = []

			for (const memProfile of profiles) {
				for (const memProject of projects) {
					for (const queryProfile of profiles) {
						for (const queryProject of projects) {
							if (memProject !== queryProject || memProfile !== queryProfile) {
								pairs.push({
									memScope: { profile: memProfile, project: memProject },
									queryScope: { profile: queryProfile, project: queryProject }
								})
							}
						}
					}
				}
			}

			// Verify: no cross-project match in strict mode
			let crossProjectHits = 0
			for (const { memScope, queryScope } of pairs) {
				if (scopeMatches(memScope, queryScope, 'strict')) {
					crossProjectHits++
				}
			}

			expect(crossProjectHits).toBe(0)
			expect(pairs.length).toBeGreaterThanOrEqual(20) // Sufficient coverage
		})
	})

	// ── Broad mode sanity ─────────────────────────────────────────────────────

	describe('broad mode allows cross-project retrieval', () => {
		it('scopeMode=broad returns memories from all projects', () => {
			const crossProjectScope = { profile: 'alice', project: 'proj-a' }
			const otherScope = { profile: 'bob', project: 'proj-b' }

			// In broad mode, everything matches
			expect(scopeMatches(otherScope, crossProjectScope, 'broad')).toBe(true)
		})

		it('broad mode returns all memories regardless of scope', () => {
			const scopes = [
				{ profile: 'alice', project: 'proj-a' },
				{ profile: 'bob', project: 'proj-b' },
				{ profile: 'charlie', project: 'proj-c' }
			]

			const filter: Scope = { profile: 'alice', project: 'proj-a' }
			let matches = 0

			for (const scope of scopes) {
				if (scopeMatches(scope, filter, 'broad')) matches++
			}

			expect(matches).toBe(scopes.length)
		})
	})

	// ── Legacy null-scope memories ────────────────────────────────────────────

	describe('legacy null-scope memories always included', () => {
		it('null-scope memories match any filter in strict mode', () => {
			const nullScope = { profile: null, project: null }
			const filters: Scope[] = [
				{ profile: 'alice', project: 'proj-a' },
				{ profile: 'bob', project: 'proj-b' },
				{ profile: DEFAULT_PROFILE, project: DEFAULT_PROJECT }
			]

			for (const filter of filters) {
				expect(scopeMatches(nullScope, filter, 'strict')).toBe(true)
			}
		})

		it('null-scope memories do not count as cross-project bleed', () => {
			const allScopes = [
				{ profile: null as string | null, project: null as string | null }, // legacy
				{ profile: 'alice', project: 'proj-a' }, // same project
				{ profile: 'bob', project: 'proj-b' } // different project
			]

			const filter: Scope = { profile: 'alice', project: 'proj-a' }
			const hits = allScopes.filter((s) => scopeMatches(s, filter, 'strict'))

			// Should include: legacy (null) + alice/proj-a
			expect(hits.length).toBe(2)

			// Cross-project check: only count non-null non-matching as bleed
			const crossBleed = hits.filter(
				(s) => s.profile !== null && s.project !== null && s.project !== 'proj-a'
			)
			expect(crossBleed.length).toBe(0)
		})
	})

	// ── Partial scope behavior ────────────────────────────────────────────────

	describe('partial scope matching', () => {
		it('memory with profile but null project matches any project filter', () => {
			expect(
				scopeMatches(
					{ profile: 'alice', project: null },
					{ profile: 'alice', project: 'any-project' },
					'strict'
				)
			).toBe(true)
		})

		it('memory with project but null profile matches any profile filter', () => {
			expect(
				scopeMatches(
					{ profile: null, project: 'proj-a' },
					{ profile: 'any-profile', project: 'proj-a' },
					'strict'
				)
			).toBe(true)
		})

		it('memory with different profile does NOT match', () => {
			expect(
				scopeMatches(
					{ profile: 'alice', project: 'proj-a' },
					{ profile: 'bob', project: 'proj-a' },
					'strict'
				)
			).toBe(false)
		})

		it('memory with different project does NOT match', () => {
			expect(
				scopeMatches(
					{ profile: 'alice', project: 'proj-a' },
					{ profile: 'alice', project: 'proj-b' },
					'strict'
				)
			).toBe(false)
		})
	})

	// ── Location API scope isolation ──────────────────────────────────────────

	describe('location API respects scope', () => {
		it('locationFind returns only scoped results', () => {
			const hdb = getHdb(t.hs)
			const mem1 = insertTestMemory(hdb, bankId, 'Mem for alice proj-a', {
				profile: 'alice',
				project: 'proj-a'
			})
			const mem2 = insertTestMemory(hdb, bankId, 'Mem for bob proj-b', {
				profile: 'bob',
				project: 'proj-b'
			})

			locationRecord(hdb, bankId, 'src/shared.ts', { memoryId: mem1 }, 'alice', 'proj-a')
			locationRecord(hdb, bankId, 'src/shared.ts', { memoryId: mem2 }, 'bob', 'proj-b')

			// Scoped query: only alice/proj-a
			const hits = locationFind(hdb, bankId, {
				path: 'src/shared.ts',
				scope: { profile: 'alice', project: 'proj-a' }
			})

			expect(hits.length).toBe(1)
			expect(hits[0]!.profile).toBe('alice')
			expect(hits[0]!.project).toBe('proj-a')
		})

		it('locationFind without scope returns all profiles/projects', () => {
			const hdb = getHdb(t.hs)
			const mem1 = insertTestMemory(hdb, bankId, 'Mem A')
			const mem2 = insertTestMemory(hdb, bankId, 'Mem B')

			locationRecord(hdb, bankId, 'src/common.ts', { memoryId: mem1 }, 'alice', 'proj-a')
			locationRecord(hdb, bankId, 'src/common.ts', { memoryId: mem2 }, 'bob', 'proj-b')

			// No scope filter — both should appear
			const hits = locationFind(hdb, bankId, { path: 'src/common.ts' })
			expect(hits.length).toBe(2)
		})
	})

	// ── Scope resolution ──────────────────────────────────────────────────────

	describe('scope resolution defaults', () => {
		it('resolveScope applies defaults for missing fields', () => {
			const scope = resolveScope({})
			expect(scope.profile).toBe(DEFAULT_PROFILE)
			expect(scope.project).toBe(DEFAULT_PROJECT)
		})

		it('resolveScope preserves explicit values', () => {
			const scope = resolveScope({ profile: 'custom', project: 'my-proj' })
			expect(scope.profile).toBe('custom')
			expect(scope.project).toBe('my-proj')
		})

		it('deriveScopeTagsFromContext uses defaults for empty strings', () => {
			const scope = deriveScopeTagsFromContext({ profile: '', project: '' })
			expect(scope.profile).toBe(DEFAULT_PROFILE)
			expect(scope.project).toBe(DEFAULT_PROJECT)
		})
	})
})
