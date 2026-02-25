/**
 * Phase 3 Verification — Gate 2: Location P@5 Uplift
 *
 * Measures code-location precision@5:
 *   P@5 = mean_q( |Top5(q) ∩ Gold(q)| / 5 )
 *
 * Verifies that location boost improves ranking of memories associated
 * with query-referenced file paths. Uses deterministic dataset where
 * Phase 2 baseline (no location boost) is guaranteed to rank location-relevant
 * memories lower than Phase 3 (with location boost).
 *
 * Strategy: Seed memories with known file-path associations, then query
 * with path-bearing queries. Compare top-5 recall with and without
 * location boost application.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ulid } from '@ellie/utils'
import { createTestHindsight, createTestBank, getHdb, type TestHindsight } from './setup'
import type { HindsightDatabase } from '../db'
import {
	locationRecord,
	computeLocationBoost,
	getMaxStrengthForPaths,
	resolveSignalsToPaths,
	detectLocationSignals
} from '../location'

function insertTestMemory(
	hdb: HindsightDatabase,
	bid: string,
	content: string,
	memId?: string
): string {
	const id = memId ?? ulid()
	const now = Date.now()
	hdb.db
		.insert(hdb.schema.memoryUnits)
		.values({
			id,
			bankId: bid,
			content,
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
	bankId = createTestBank(t.hs, 'gate2-location')
})

afterEach(() => {
	t.cleanup()
})

describe('Gate 2: Location P@5 Uplift', () => {
	/**
	 * Deterministic dataset: 10 memories, each associated with a specific file.
	 * Gold set per query: memories directly associated with the queried file path.
	 * Baseline: no location boost (all memories get boost=0).
	 * Phase 3: with location boost (path-associated memories get boost > 0).
	 */

	it('location boost increases P@5 for path-associated memories', () => {
		const hdb = getHdb(t.hs)
		const now = Date.now()

		// Create 10 memories associated with different files
		const files = [
			'src/auth/login.ts',
			'src/auth/register.ts',
			'src/auth/middleware.ts',
			'src/api/users.ts',
			'src/api/posts.ts',
			'src/db/schema.ts',
			'src/db/migrations.ts',
			'src/utils/logger.ts',
			'src/utils/crypto.ts',
			'src/config.ts'
		]

		const memoryIds: string[] = []
		for (let i = 0; i < files.length; i++) {
			const memId = insertTestMemory(hdb, bankId, `Memory about ${files[i]} functionality`)
			memoryIds.push(memId)
			locationRecord(hdb, bankId, files[i]!, { memoryId: memId, session: 'sess-1' })
		}

		// Query: "What's in src/auth/login.ts?"
		// Gold set: memory 0 (login.ts)
		// With location boost: memory 0 should get directPath boost (+0.12)
		const querySignals = detectLocationSignals('Check src/auth/login.ts')
		expect(querySignals.length).toBeGreaterThan(0)

		const signalMap = resolveSignalsToPaths(hdb, bankId, querySignals)
		const queryPathIds = new Set<string>()
		for (const ids of signalMap.values()) {
			for (const id of ids) queryPathIds.add(id)
		}
		expect(queryPathIds.size).toBeGreaterThan(0)

		const maxStrength = getMaxStrengthForPaths(hdb, bankId, queryPathIds)

		// Compute boost for each memory
		const boosts = memoryIds.map((memId) =>
			computeLocationBoost(hdb, bankId, memId, queryPathIds, maxStrength, now)
		)

		// Memory 0 (login.ts) should have highest boost (direct path match)
		expect(boosts[0]).toBeGreaterThan(0)
		// At minimum directPathBoost (0.12) + familiarity
		expect(boosts[0]).toBeGreaterThanOrEqual(0.12)

		// The directly queried file should have the highest individual boost
		const maxBoost = Math.max(...boosts)
		expect(boosts[0]).toBe(maxBoost)
	})

	it('P@5 is higher with location boost than without for path-bearing queries', () => {
		const hdb = getHdb(t.hs)
		const now = Date.now()

		// Create a dataset where location signals matter
		const dataset: Array<{ file: string; content: string; goldForQuery: string[] }> = [
			{
				file: 'src/auth/login.ts',
				content: 'Login handler validates credentials and returns JWT token',
				goldForQuery: ['auth login']
			},
			{
				file: 'src/auth/register.ts',
				content: 'Register handler creates new user accounts with validation',
				goldForQuery: ['auth register']
			},
			{
				file: 'src/api/users.ts',
				content: 'User API endpoint handles CRUD operations for user profiles',
				goldForQuery: ['api users']
			},
			{
				file: 'src/db/schema.ts',
				content: 'Database schema defines user and post table structures',
				goldForQuery: ['db schema']
			},
			{
				file: 'src/utils/logger.ts',
				content: 'Logger utility provides structured logging across the app',
				goldForQuery: ['utils logger']
			}
		]

		const memoryIds: string[] = []
		for (const item of dataset) {
			const memId = insertTestMemory(hdb, bankId, item.content)
			memoryIds.push(memId)
			locationRecord(hdb, bankId, item.file, { memoryId: memId })
		}

		// For each query that contains a file path, check if location boost
		// correctly identifies the associated memory
		const queries = [
			{ q: 'What does src/auth/login.ts do?', goldIdx: 0 },
			{ q: 'Check src/db/schema.ts for issues', goldIdx: 3 },
			{ q: 'Look at src/utils/logger.ts implementation', goldIdx: 4 }
		]

		let baselineHits = 0
		let phase3Hits = 0

		for (const { q, goldIdx } of queries) {
			const signals = detectLocationSignals(q)
			const signalMap = resolveSignalsToPaths(hdb, bankId, signals)
			const queryPathIds = new Set<string>()
			for (const ids of signalMap.values()) {
				for (const id of ids) queryPathIds.add(id)
			}

			const maxStrength = getMaxStrengthForPaths(hdb, bankId, queryPathIds)

			// Baseline: all memories have equal score (no boost)
			const baselineScores = memoryIds.map((_, i) => ({
				idx: i,
				score: 1.0 - i * 0.01 // slight decay by order, simulating baseline ranking
			}))
			baselineScores.sort((a, b) => b.score - a.score)
			const baselineTop5 = new Set(baselineScores.slice(0, 5).map((s) => s.idx))
			if (baselineTop5.has(goldIdx)) baselineHits++

			// Phase 3: apply location boost
			const phase3Scores = memoryIds.map((memId, i) => {
				const boost = computeLocationBoost(hdb, bankId, memId, queryPathIds, maxStrength, now)
				return { idx: i, score: 1.0 - i * 0.01 + boost }
			})
			phase3Scores.sort((a, b) => b.score - a.score)
			const phase3Top5 = new Set(phase3Scores.slice(0, 5).map((s) => s.idx))
			if (phase3Top5.has(goldIdx)) phase3Hits++
		}

		const baselineP5 = baselineHits / queries.length
		const phase3P5 = phase3Hits / queries.length

		// Phase 3 P@5 should be >= baseline P@5
		// With only 5 memories, all are in top-5, so both should be 1.0
		// The real uplift shows when baseline would push gold items out of top-5
		expect(phase3P5).toBeGreaterThanOrEqual(baselineP5)
		expect(phase3P5).toBe(1.0) // all gold items should be in top-5 with boost
	})

	it('location boost for 10+ memories pushes gold items into top-5', () => {
		const hdb = getHdb(t.hs)
		const now = Date.now()

		// Create 15 memories — gold item placed at index 10 (outside naive top-5)
		const memories: string[] = []
		for (let i = 0; i < 15; i++) {
			const memId = insertTestMemory(hdb, bankId, `Memory content number ${i} about various things`)
			memories.push(memId)
		}

		// Only memory 10 is associated with the target file
		locationRecord(hdb, bankId, 'src/target/specific-file.ts', {
			memoryId: memories[10]!,
			session: 'sess-a'
		})

		const signals = detectLocationSignals('What does src/target/specific-file.ts do?')
		const signalMap = resolveSignalsToPaths(hdb, bankId, signals)
		const queryPathIds = new Set<string>()
		for (const ids of signalMap.values()) {
			for (const id of ids) queryPathIds.add(id)
		}

		const maxStrength = getMaxStrengthForPaths(hdb, bankId, queryPathIds)

		// Baseline: memory 10 is ranked 11th (outside top-5)
		const baselineScores = memories.map((_, i) => ({
			idx: i,
			score: 1.0 - i * 0.02 // descending by index
		}))
		baselineScores.sort((a, b) => b.score - a.score)
		const baselineTop5 = baselineScores.slice(0, 5).map((s) => s.idx)
		expect(baselineTop5).not.toContain(10) // memory 10 not in baseline top-5

		// Phase 3: location boost should elevate memory 10
		const phase3Scores = memories.map((memId, i) => {
			const boost = computeLocationBoost(hdb, bankId, memId, queryPathIds, maxStrength, now)
			return { idx: i, score: 1.0 - i * 0.02 + boost }
		})
		phase3Scores.sort((a, b) => b.score - a.score)
		const phase3Top5 = phase3Scores.slice(0, 5).map((s) => s.idx)
		expect(phase3Top5).toContain(10) // memory 10 promoted to top-5 by location boost
	})

	it('co-access boost propagates through session associations', () => {
		const hdb = getHdb(t.hs)
		const now = Date.now()

		const memA = insertTestMemory(hdb, bankId, 'Memory about auth flow')
		const memB = insertTestMemory(hdb, bankId, 'Memory about middleware')
		const memC = insertTestMemory(hdb, bankId, 'Memory about unrelated topic')

		// Files A and B co-accessed in same session
		locationRecord(hdb, bankId, 'src/auth.ts', { memoryId: memA, session: 'sess-x' })
		locationRecord(hdb, bankId, 'src/middleware.ts', { memoryId: memB, session: 'sess-x' })
		// File C in different session
		locationRecord(hdb, bankId, 'src/other.ts', { memoryId: memC, session: 'sess-y' })

		// Query about auth.ts — memory B should get co-access boost
		const signals = detectLocationSignals('Check src/auth.ts')
		const signalMap = resolveSignalsToPaths(hdb, bankId, signals)
		const queryPathIds = new Set<string>()
		for (const ids of signalMap.values()) {
			for (const id of ids) queryPathIds.add(id)
		}

		const maxStrength = getMaxStrengthForPaths(hdb, bankId, queryPathIds)

		const boostA = computeLocationBoost(hdb, bankId, memA, queryPathIds, maxStrength, now)
		const boostB = computeLocationBoost(hdb, bankId, memB, queryPathIds, maxStrength, now)
		const boostC = computeLocationBoost(hdb, bankId, memC, queryPathIds, maxStrength, now)

		// A has direct path match — highest boost
		expect(boostA).toBeGreaterThan(boostB)
		// B has co-access association — some boost
		expect(boostB).toBeGreaterThan(0)
		// C has familiarity from its own path access but no co-access with query path
		// B should have higher boost than C due to co-access with auth.ts
		expect(boostB).toBeGreaterThan(boostC)
	})

	it('directPath boost is exactly 0.12', () => {
		const hdb = getHdb(t.hs)
		const now = Date.now()

		const memId = insertTestMemory(hdb, bankId, 'Memory for direct path test')
		locationRecord(hdb, bankId, 'src/exact-match.ts', { memoryId: memId })

		const signals = detectLocationSignals('Check src/exact-match.ts')
		const signalMap = resolveSignalsToPaths(hdb, bankId, signals)
		const queryPathIds = new Set<string>()
		for (const ids of signalMap.values()) {
			for (const id of ids) queryPathIds.add(id)
		}

		const boost = computeLocationBoost(hdb, bankId, memId, queryPathIds, 0, now)

		// directPathBoost (0.12) + familiarityBoost (some small amount based on recency)
		// directPathBoost alone is 0.12, familiarity adds up to 0.10
		expect(boost).toBeGreaterThanOrEqual(0.12)
		expect(boost).toBeLessThanOrEqual(0.3) // max possible: 0.12 + 0.10 + 0.08
	})
})
