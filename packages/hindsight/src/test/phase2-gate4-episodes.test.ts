/**
 * Phase 2 Verification — Gate 4: Episode Boundary + Linking
 *
 * Verifies:
 * - Boundary trigger rules: >45 min gap, scope change, phrase boundary
 * - Precedence: phrase boundary > scope change > time gap
 * - Exactness: gap exactly 45 min does NOT trigger; gap > 45 min triggers
 * - hs_episode_temporal_links created on boundary transitions
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createTestHindsight, createTestBank, getHdb, type TestHindsight } from './setup'
import { detectBoundary, EPISODE_GAP_MS } from '../episodes'
import type { EpisodeRow } from '../schema'

// ── Helper: create a fake episode row ─────────────────────────────────────

function fakeEpisode(overrides: Partial<EpisodeRow> = {}): EpisodeRow {
	const now = Date.now()
	return {
		id: 'ep-1',
		bankId: 'bank-1',
		profile: null,
		project: null,
		session: null,
		startAt: now - 1000,
		endAt: null,
		lastEventAt: now - 1000,
		eventCount: 1,
		boundaryReason: null,
		...overrides
	}
}

describe('Gate 4: Episode Boundary + Linking', () => {
	// ── Boundary trigger rules (pure function) ──────────────────────────────

	describe('boundary trigger rules', () => {
		it('no last episode => initial boundary', () => {
			const result = detectBoundary(null, Date.now(), null, null, null)
			expect(result.needsNew).toBe(true)
			expect(result.reason).toBe('initial')
		})

		it('>45 min gap triggers new episode with reason=time_gap', () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - EPISODE_GAP_MS - 1 })
			const result = detectBoundary(ep, now, null, null, null)
			expect(result.needsNew).toBe(true)
			expect(result.reason).toBe('time_gap')
		})

		it('scope change (profile) triggers new episode', () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - 1000, profile: 'alice' })
			const result = detectBoundary(ep, now, 'bob', null, null)
			expect(result.needsNew).toBe(true)
			expect(result.reason).toBe('scope_change')
		})

		it('scope change (project) triggers new episode', () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - 1000, project: 'proj-a' })
			const result = detectBoundary(ep, now, null, 'proj-b', null)
			expect(result.needsNew).toBe(true)
			expect(result.reason).toBe('scope_change')
		})

		it('scope change (session) triggers new episode', () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - 1000, session: 's1' })
			const result = detectBoundary(ep, now, null, null, 's2')
			expect(result.needsNew).toBe(true)
			expect(result.reason).toBe('scope_change')
		})

		it("phrase 'new task' triggers boundary", () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - 1000 })
			const result = detectBoundary(ep, now, null, null, null, 'Starting a new task now')
			expect(result.needsNew).toBe(true)
			expect(result.reason).toBe('phrase_boundary')
		})

		it("phrase 'switching to' triggers boundary", () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - 1000 })
			const result = detectBoundary(ep, now, null, null, null, "I'm switching to the backend")
			expect(result.needsNew).toBe(true)
			expect(result.reason).toBe('phrase_boundary')
		})

		it("phrase 'done with' triggers boundary", () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - 1000 })
			const result = detectBoundary(ep, now, null, null, null, "I'm done with this feature")
			expect(result.needsNew).toBe(true)
			expect(result.reason).toBe('phrase_boundary')
		})
	})

	// ── Precedence: phrase > scope > time gap ──────────────────────────────

	describe('boundary precedence', () => {
		it('phrase boundary takes precedence over scope change', () => {
			const now = Date.now()
			const ep = fakeEpisode({
				lastEventAt: now - 1000,
				profile: 'alice'
			})
			// Both scope change (alice -> bob) AND phrase boundary
			const result = detectBoundary(ep, now, 'bob', null, null, 'Starting a new task')
			expect(result.reason).toBe('phrase_boundary')
		})

		it('phrase boundary takes precedence over time gap', () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - 60 * 60 * 1000 }) // 1hr gap
			const result = detectBoundary(ep, now, null, null, null, "I'm done with this")
			expect(result.reason).toBe('phrase_boundary')
		})

		it('scope change takes precedence over time gap', () => {
			const now = Date.now()
			const ep = fakeEpisode({
				lastEventAt: now - 60 * 60 * 1000,
				profile: 'alice'
			}) // 1hr gap + scope change
			const result = detectBoundary(ep, now, 'bob', null, null)
			// Both could trigger. Scope change is checked before time gap, but
			// phrase boundary is checked before scope change.
			// Without phrase content, scope_change should win over time_gap.
			expect(result.reason).toBe('scope_change')
		})
	})

	// ── Exactness: 45 min boundary ─────────────────────────────────────────

	describe('45-minute boundary exactness', () => {
		it('gap exactly 45 min (45*60*1000 ms) does NOT trigger', () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - EPISODE_GAP_MS })
			const result = detectBoundary(ep, now, null, null, null)
			expect(result.needsNew).toBe(false)
			expect(result.reason).toBeNull()
		})

		it('gap 45 min + 1ms DOES trigger', () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - EPISODE_GAP_MS - 1 })
			const result = detectBoundary(ep, now, null, null, null)
			expect(result.needsNew).toBe(true)
			expect(result.reason).toBe('time_gap')
		})

		it('gap 44 min 59 sec does NOT trigger', () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - (44 * 60 * 1000 + 59 * 1000) })
			const result = detectBoundary(ep, now, null, null, null)
			expect(result.needsNew).toBe(false)
		})

		it('gap 46 min DOES trigger', () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - 46 * 60 * 1000 })
			const result = detectBoundary(ep, now, null, null, null)
			expect(result.needsNew).toBe(true)
			expect(result.reason).toBe('time_gap')
		})
	})

	// ── No boundary within gap and same scope ──────────────────────────────

	describe('no boundary cases', () => {
		it('same scope within 45 min => no boundary', () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - 10_000 })
			const result = detectBoundary(ep, now, null, null, null)
			expect(result.needsNew).toBe(false)
			expect(result.reason).toBeNull()
		})

		it('same scope with non-boundary content => no boundary', () => {
			const now = Date.now()
			const ep = fakeEpisode({ lastEventAt: now - 10_000 })
			const result = detectBoundary(ep, now, null, null, null, 'Regular message content')
			expect(result.needsNew).toBe(false)
			expect(result.reason).toBeNull()
		})
	})

	// ── Integration: temporal links ─────────────────────────────────────────

	describe('temporal links on boundary transitions', () => {
		let t: TestHindsight
		let bankId: string

		beforeEach(() => {
			t = createTestHindsight()
			bankId = createTestBank(t.hs)
		})

		afterEach(() => {
			t.cleanup()
		})

		it('temporal link is created between consecutive episodes', async () => {
			// Create first episode
			await t.hs.retain(bankId, 'first', {
				facts: [{ content: 'First fact alpha xyz 123', factType: 'experience' }],
				session: 'session-1',
				consolidate: false
			})

			// Trigger new episode with phrase boundary
			await t.hs.retain(bankId, 'second', {
				facts: [{ content: 'new task second fact beta 456', factType: 'experience' }],
				session: 'session-1',
				consolidate: false
			})

			const hdb = getHdb(t.hs)
			const links = hdb.sqlite.prepare('SELECT * FROM hs_episode_temporal_links').all() as Array<
				Record<string, unknown>
			>

			expect(links).toHaveLength(1)
			expect(links[0]!.reason).toBeDefined()
			expect(links[0]!.gap_ms).toBeDefined()
			expect(typeof links[0]!.gap_ms).toBe('number')
		})

		it('temporal link connects from_episode to to_episode correctly', async () => {
			await t.hs.retain(bankId, 'first', {
				facts: [{ content: 'First fact alpha xyz 123', factType: 'experience' }],
				consolidate: false
			})

			// Trigger phrase boundary (same scope so resolveEpisode finds the prior episode)
			await t.hs.retain(bankId, 'second', {
				facts: [{ content: 'done with Second fact beta 456 !@#', factType: 'experience' }],
				consolidate: false
			})

			const hdb = getHdb(t.hs)
			const episodes = hdb.sqlite
				.prepare('SELECT * FROM hs_episodes WHERE bank_id = ? ORDER BY start_at ASC')
				.all(bankId) as Array<Record<string, unknown>>

			expect(episodes).toHaveLength(2)

			const links = hdb.sqlite.prepare('SELECT * FROM hs_episode_temporal_links').all() as Array<
				Record<string, unknown>
			>

			expect(links).toHaveLength(1)
			expect(links[0]!.from_episode_id).toBe(episodes[0]!.id)
			expect(links[0]!.to_episode_id).toBe(episodes[1]!.id)
		})

		it('no temporal link when no boundary crossed', async () => {
			await t.hs.retain(bankId, 'first', {
				facts: [{ content: 'First fact alpha xyz 123', factType: 'experience' }],
				consolidate: false
			})

			await t.hs.retain(bankId, 'second', {
				facts: [{ content: 'Second fact beta 456 !@#', factType: 'experience' }],
				consolidate: false
			})

			const hdb = getHdb(t.hs)
			const episodes = hdb.sqlite
				.prepare('SELECT * FROM hs_episodes WHERE bank_id = ?')
				.all(bankId) as Array<Record<string, unknown>>

			expect(episodes).toHaveLength(1) // Same episode

			const links = hdb.sqlite.prepare('SELECT * FROM hs_episode_temporal_links').all() as Array<
				Record<string, unknown>
			>

			expect(links).toHaveLength(0)
		})

		it('episode event_count increments within same episode', async () => {
			await t.hs.retain(bankId, 'batch', {
				facts: [
					{ content: 'Fact one alpha xyz', factType: 'world' },
					{ content: 'Fact two beta 123 !@#', factType: 'world' },
					{ content: 'Fact three gamma 456 $%^', factType: 'world' }
				],
				consolidate: false
			})

			const hdb = getHdb(t.hs)
			const episodes = hdb.sqlite
				.prepare('SELECT * FROM hs_episodes WHERE bank_id = ?')
				.all(bankId) as Array<Record<string, unknown>>

			expect(episodes).toHaveLength(1)
			expect(episodes[0]!.event_count).toBe(3)
		})

		it('closing episode sets endAt on boundary', async () => {
			await t.hs.retain(bankId, 'first', {
				facts: [{ content: 'First fact alpha xyz 123', factType: 'experience' }],
				consolidate: false
			})

			// Use phrase boundary (same scope) so resolveEpisode finds and closes the prior episode
			await t.hs.retain(bankId, 'second', {
				facts: [{ content: 'switching to Second fact beta 456 !@#', factType: 'experience' }],
				consolidate: false
			})

			const hdb = getHdb(t.hs)
			const episodes = hdb.sqlite
				.prepare('SELECT * FROM hs_episodes WHERE bank_id = ? ORDER BY start_at ASC')
				.all(bankId) as Array<Record<string, unknown>>

			expect(episodes).toHaveLength(2)
			// First episode should have endAt set
			expect(episodes[0]!.end_at).not.toBeNull()
			// Second episode should still be open
			expect(episodes[1]!.end_at).toBeNull()
		})

		it('episode boundary_reason is recorded', async () => {
			await t.hs.retain(bankId, 'first', {
				facts: [{ content: 'First fact alpha xyz 123', factType: 'experience' }],
				consolidate: false
			})

			await t.hs.retain(bankId, 'second', {
				facts: [{ content: 'new task Second fact beta 456', factType: 'experience' }],
				consolidate: false
			})

			const hdb = getHdb(t.hs)
			const episodes = hdb.sqlite
				.prepare('SELECT * FROM hs_episodes WHERE bank_id = ? ORDER BY start_at ASC')
				.all(bankId) as Array<Record<string, unknown>>

			expect(episodes).toHaveLength(2)
			expect(episodes[0]!.boundary_reason).toBe('initial')
			expect(episodes[1]!.boundary_reason).toBe('phrase_boundary')
		})
	})
})
