import { eq, and } from 'drizzle-orm'
import { createHash } from 'crypto'
import type { AnyTextAdapter } from '@tanstack/ai'
import type { HindsightDatabase } from './db'
import type {
	MemoryUnit,
	Entity,
	FactType,
	EntityType
} from './types'
import type { ObservationHistoryEntry } from './types'
import { generateGistWithLLM } from './gist'

import { safeJsonParse } from './util'

export function runInTransaction(
	hdb: HindsightDatabase,
	fn: () => void
): void {
	hdb.db.transaction(() => {
		fn()
	})
}

export function buildContentHash(content: string): string {
	return createHash('sha256').update(content).digest('hex')
}

export function upsertDocuments(
	hdb: HindsightDatabase,
	rows: Array<typeof hdb.schema.documents.$inferInsert>
): void {
	for (const row of rows) {
		hdb.db
			.delete(hdb.schema.documents)
			.where(
				and(
					eq(hdb.schema.documents.id, row.id),
					eq(hdb.schema.documents.bankId, row.bankId)
				)
			)
			.run()
		hdb.db.insert(hdb.schema.documents).values(row).run()
	}
}

export function upsertChunks(
	hdb: HindsightDatabase,
	rows: Array<typeof hdb.schema.chunks.$inferInsert>
): void {
	for (const row of rows) {
		hdb.db
			.delete(hdb.schema.chunks)
			.where(eq(hdb.schema.chunks.id, row.id))
			.run()
		hdb.db.insert(hdb.schema.chunks).values(row).run()
	}
}

export function rowToMemoryUnit(
	row: typeof import('./schema').memoryUnits.$inferSelect
): MemoryUnit {
	const occurredStart = row.occurredStart
	const occurredEnd = row.occurredEnd
	const mentionedAt = row.mentionedAt
	const eventDate =
		row.eventDate ?? occurredStart ?? mentionedAt

	return {
		id: row.id,
		bankId: row.bankId,
		content: row.content,
		factType: row.factType as FactType,
		confidence: row.confidence,
		documentId: row.documentId,
		chunkId: row.chunkId,
		eventDate,
		occurredStart,
		occurredEnd,
		mentionedAt,
		metadata: safeJsonParse<Record<string, unknown> | null>(
			row.metadata,
			null
		),
		tags: safeJsonParse<string[] | null>(row.tags, null),
		sourceText: row.sourceText,
		consolidatedAt: row.consolidatedAt,
		proofCount: row.proofCount,
		sourceMemoryIds: safeJsonParse<string[] | null>(
			row.sourceMemoryIds,
			null
		),
		history: safeJsonParse<
			ObservationHistoryEntry[] | null
		>(row.history, null),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	}
}

export function rowToEntity(
	row: typeof import('./schema').entities.$inferSelect
): Entity {
	return {
		id: row.id,
		bankId: row.bankId,
		name: row.name,
		entityType: row.entityType as EntityType,
		description: row.description,
		metadata: safeJsonParse<Record<string, unknown> | null>(
			row.metadata,
			null
		),
		firstSeen: row.firstSeen,
		lastUpdated: row.lastUpdated
	}
}

/** Max concurrent LLM gist generation requests. */
const GIST_CONCURRENCY = 3

/**
 * Fire-and-forget LLM gist upgrade with bounded concurrency.
 * Runs at most GIST_CONCURRENCY requests in parallel and logs per-item errors
 * without aborting the queue.
 */
export function scheduleGistUpgrades(
	adapter: AnyTextAdapter,
	hdb: HindsightDatabase,
	schema: typeof import('./schema'),
	memories: { id: string; content: string }[]
): void {
	const queue = memories
	if (queue.length === 0) return

	let cursor = 0

	async function runLane(): Promise<void> {
		while (cursor < queue.length) {
			const mem = queue[cursor++]!
			try {
				const gist = await generateGistWithLLM(
					adapter,
					mem.content
				)
				hdb.db
					.update(schema.memoryUnits)
					.set({ gist })
					.where(eq(schema.memoryUnits.id, mem.id))
					.run()
			} catch {
				// Expected when DB closes before async gist finishes
			}
		}
	}

	const laneCount = Math.min(GIST_CONCURRENCY, queue.length)
	for (let i = 0; i < laneCount; i++) {
		runLane()
	}
}
