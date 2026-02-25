/**
 * Phase 4: Minimal Visual Semantics
 *
 * Ingests text-only visual descriptions (captions / scene summaries),
 * embeds and indexes them, and supports retrieval for recall fusion.
 * Feature is optional and default-off.
 */

import { ulid } from '@ellie/utils'
import { eq, and } from 'drizzle-orm'
import type { HindsightDatabase } from './db'
import type { EmbeddingStore } from './embedding'
import type {
	VisualRetainInput,
	VisualRetainResult,
	VisualStats,
	VisualFindHit,
	ScoredVisualMemory
} from './types'

// ── Ingest ──────────────────────────────────────────────────────────────

/**
 * Store a visual description and its embedding.
 *
 * Validates that the description is non-empty, inserts into
 * hs_visual_memories, and upserts the embedding into hs_visual_vec.
 */
export async function retainVisual(
	hdb: HindsightDatabase,
	visualVec: EmbeddingStore,
	input: VisualRetainInput
): Promise<VisualRetainResult> {
	const description = input.description?.trim()
	if (!description || description.length === 0) {
		throw new Error('Visual description must not be empty')
	}

	const id = ulid()
	const now = input.ts ?? Date.now()

	hdb.db
		.insert(hdb.schema.visualMemories)
		.values({
			id,
			bankId: input.bankId,
			sourceId: input.sourceId ?? null,
			description,
			scopeProfile: input.scope?.profile ?? null,
			scopeProject: input.scope?.project ?? null,
			scopeSession: input.scope?.session ?? null,
			createdAt: now,
			updatedAt: now
		})
		.run()

	await visualVec.upsert(id, description)

	return {
		id,
		bankId: input.bankId,
		sourceId: input.sourceId ?? null,
		description,
		createdAt: now
	}
}

// ── Retrieval ────────────────────────────────────────────────────────────

/** Minimum relevance threshold — visual candidates below this are discarded. */
const VISUAL_RELEVANCE_THRESHOLD = 0.3

/**
 * Search visual embeddings by query text.
 *
 * Returns top-k visual memories sorted by cosine similarity,
 * filtered by minimum relevance threshold.
 */
export async function searchVisual(
	hdb: HindsightDatabase,
	visualVec: EmbeddingStore,
	bankId: string,
	query: string,
	limit: number
): Promise<ScoredVisualMemory[]> {
	if (limit <= 0) return []

	// Over-fetch for bank filtering
	const knnResults = await visualVec.search(
		query,
		limit * 3
	)

	const results: ScoredVisualMemory[] = []

	for (const hit of knnResults) {
		if (results.length >= limit) break

		const similarity = 1 - hit.distance
		if (similarity < VISUAL_RELEVANCE_THRESHOLD) continue

		const row = hdb.db
			.select()
			.from(hdb.schema.visualMemories)
			.where(
				and(
					eq(hdb.schema.visualMemories.id, hit.id),
					eq(hdb.schema.visualMemories.bankId, bankId)
				)
			)
			.get()

		if (!row) continue

		results.push({
			id: row.id,
			bankId: row.bankId,
			sourceId: row.sourceId,
			description: row.description,
			score: similarity,
			createdAt: row.createdAt
		})
	}

	return results
}

// ── Access History ────────────────────────────────────────────────────────

/**
 * Record access events for visual memories returned to the caller.
 * Appends new rows (no overwrite) per the spec.
 */
export function recordVisualAccess(
	hdb: HindsightDatabase,
	bankId: string,
	visualMemoryIds: string[],
	sessionId?: string
): void {
	if (visualMemoryIds.length === 0) return

	const now = Date.now()
	for (const visualMemoryId of visualMemoryIds) {
		hdb.db
			.insert(hdb.schema.visualAccessHistory)
			.values({
				id: ulid(),
				bankId,
				visualMemoryId,
				accessedAt: now,
				sessionId: sessionId ?? null
			})
			.run()
	}
}

// ── Stats ────────────────────────────────────────────────────────────────

/**
 * Get stats for visual memories in a bank.
 */
export function getVisualStats(
	hdb: HindsightDatabase,
	bankId: string
): VisualStats {
	const memoryCount = hdb.sqlite
		.prepare(
			`SELECT COUNT(*) as count FROM hs_visual_memories WHERE bank_id = ?`
		)
		.get(bankId) as { count: number } | undefined

	const accessCount = hdb.sqlite
		.prepare(
			`SELECT COUNT(*) as count FROM hs_visual_access_history WHERE bank_id = ?`
		)
		.get(bankId) as { count: number } | undefined

	return {
		bankId,
		totalVisualMemories: memoryCount?.count ?? 0,
		totalAccessEvents: accessCount?.count ?? 0
	}
}

// ── Find ─────────────────────────────────────────────────────────────────

/**
 * Find visual memories by semantic search.
 */
export async function visualFind(
	hdb: HindsightDatabase,
	visualVec: EmbeddingStore,
	bankId: string,
	query: string,
	limit: number = 10
): Promise<VisualFindHit[]> {
	if (!query || query.trim().length === 0) return []

	const knnResults = await visualVec.search(
		query,
		limit * 3
	)

	const results: VisualFindHit[] = []

	for (const hit of knnResults) {
		if (results.length >= limit) break

		const row = hdb.db
			.select()
			.from(hdb.schema.visualMemories)
			.where(
				and(
					eq(hdb.schema.visualMemories.id, hit.id),
					eq(hdb.schema.visualMemories.bankId, bankId)
				)
			)
			.get()

		if (!row) continue

		results.push({
			id: row.id,
			sourceId: row.sourceId,
			description: row.description,
			distance: hit.distance,
			createdAt: row.createdAt
		})
	}

	return results
}

// ── Cleanup ──────────────────────────────────────────────────────────────

/**
 * Delete all visual memories and their embeddings for a bank.
 * Called during bank deletion to clean up vec0 entries.
 */
export function deleteVisualMemoriesForBank(
	hdb: HindsightDatabase,
	visualVec: EmbeddingStore,
	bankId: string
): void {
	const ids = hdb.db
		.select({ id: hdb.schema.visualMemories.id })
		.from(hdb.schema.visualMemories)
		.where(eq(hdb.schema.visualMemories.bankId, bankId))
		.all()

	for (const { id } of ids) {
		visualVec.delete(id)
	}
}
