import { ulid } from 'fast-ulid'
import { eq, and } from 'drizzle-orm'
import type { HindsightDatabase } from './db'
import type { EmbeddingStore } from './embedding'
import type {
	RetainResult,
	MemoryUnit,
	LinkType
} from './types'
import {
	TEMPORAL_LINK_WINDOW_HOURS,
	computeTemporalLinks,
	computeTemporalQueryBounds,
	computeTemporalWeight
} from './retain-link-utils'
import type {
	ExtractedCausalRelation,
	PreparedExtractedFact
} from './retain-extract'

// ── Constants ───────────────────────────────────────────────────────────────

export const SEMANTIC_LINK_THRESHOLD = 0.7
export const SEMANTIC_LINK_TOP_K = 5

// ── Entity links ────────────────────────────────────────────────────────────

export function createEntityLinksFromMemories(
	hdb: HindsightDatabase,
	bankId: string,
	memoryIds: string[],
	memoryEntityNames: Map<string, Set<string>>,
	createdAt: number,
	output: RetainResult['links']
): void {
	if (memoryIds.length < 2) return

	// Build inverted index: entity name → memory indices
	const entityToIndices = new Map<string, number[]>()
	const entityCountPerMemory: number[] = []
	for (let i = 0; i < memoryIds.length; i++) {
		const names =
			memoryEntityNames.get(memoryIds[i]!) ??
			new Set<string>()
		entityCountPerMemory[i] = names.size
		for (const name of names) {
			let bucket = entityToIndices.get(name)
			if (!bucket) {
				bucket = []
				entityToIndices.set(name, bucket)
			}
			bucket.push(i)
		}
	}

	// Accumulate shared entity counts per pair via bucket join
	const pairShared = new Map<string, number>()
	for (const bucket of entityToIndices.values()) {
		if (bucket.length < 2) continue
		for (let a = 0; a < bucket.length; a++) {
			for (let b = a + 1; b < bucket.length; b++) {
				const key = `${bucket[a]}:${bucket[b]}`
				pairShared.set(key, (pairShared.get(key) ?? 0) + 1)
			}
		}
	}

	// Emit links
	for (const [key, shared] of pairShared) {
		const [iStr, jStr] = key.split(':')
		const i = Number(iStr)
		const j = Number(jStr)
		const weight =
			shared /
			Math.max(
				entityCountPerMemory[i]!,
				entityCountPerMemory[j]!,
				1
			)

		hdb.db
			.insert(hdb.schema.memoryLinks)
			.values({
				id: ulid(),
				bankId,
				sourceId: memoryIds[i]!,
				targetId: memoryIds[j]!,
				linkType: 'entity',
				weight,
				createdAt
			})
			.onConflictDoNothing()
			.run()

		output.push({
			sourceId: memoryIds[i]!,
			targetId: memoryIds[j]!,
			linkType: 'entity'
		})
	}
}

// ── Temporal links ──────────────────────────────────────────────────────────

export function getTemporalAnchor(
	eventDate: number | null,
	occurredStart: number | null,
	occurredEnd: number | null,
	mentionedAt: number | null,
	createdAt: number
): number | null {
	return (
		eventDate ??
		occurredStart ??
		occurredEnd ??
		mentionedAt ??
		createdAt
	)
}

export function insertTemporalLinkIfMissing(
	hdb: HindsightDatabase,
	bankId: string,
	sourceId: string,
	targetId: string,
	weight: number,
	createdAt: number,
	output: RetainResult['links']
): void {
	if (sourceId === targetId) return

	const existing = hdb.db
		.select({ id: hdb.schema.memoryLinks.id })
		.from(hdb.schema.memoryLinks)
		.where(
			and(
				eq(hdb.schema.memoryLinks.bankId, bankId),
				eq(hdb.schema.memoryLinks.sourceId, sourceId),
				eq(hdb.schema.memoryLinks.targetId, targetId),
				eq(hdb.schema.memoryLinks.linkType, 'temporal')
			)
		)
		.get()
	if (existing) return

	hdb.db
		.insert(hdb.schema.memoryLinks)
		.values({
			id: ulid(),
			bankId,
			sourceId,
			targetId,
			linkType: 'temporal',
			weight,
			createdAt
		})
		.run()

	output.push({ sourceId, targetId, linkType: 'temporal' })
}

export function linkWithinBatchTemporal(
	hdb: HindsightDatabase,
	bankId: string,
	source: MemoryUnit,
	sourceAnchor: number,
	newMemories: MemoryUnit[],
	startIndex: number,
	windowMs: number,
	createdAt: number,
	output: RetainResult['links']
): void {
	for (let j = startIndex; j < newMemories.length; j++) {
		const target = newMemories[j]!
		const targetAnchor = getTemporalAnchor(
			target.eventDate,
			target.occurredStart,
			target.occurredEnd,
			target.mentionedAt,
			target.createdAt
		)
		if (targetAnchor == null) continue

		const distanceMs = Math.abs(sourceAnchor - targetAnchor)
		if (distanceMs > windowMs) continue
		const weight = computeTemporalWeight(
			distanceMs,
			windowMs
		)

		insertTemporalLinkIfMissing(
			hdb,
			bankId,
			source.id,
			target.id,
			weight,
			createdAt,
			output
		)
		insertTemporalLinkIfMissing(
			hdb,
			bankId,
			target.id,
			source.id,
			weight,
			createdAt,
			output
		)
	}
}

export function createTemporalLinksFromMemories(
	hdb: HindsightDatabase,
	bankId: string,
	newMemories: MemoryUnit[],
	createdAt: number,
	output: RetainResult['links']
): void {
	if (newMemories.length === 0) return

	const windowMs =
		TEMPORAL_LINK_WINDOW_HOURS * 60 * 60 * 1000
	const newMemoryIds = new Set(
		newMemories.map(memory => memory.id)
	)
	const candidateRows = hdb.db
		.select({
			id: hdb.schema.memoryUnits.id,
			bankId: hdb.schema.memoryUnits.bankId,
			eventDate: hdb.schema.memoryUnits.eventDate,
			occurredStart: hdb.schema.memoryUnits.occurredStart,
			occurredEnd: hdb.schema.memoryUnits.occurredEnd,
			mentionedAt: hdb.schema.memoryUnits.mentionedAt,
			createdAt: hdb.schema.memoryUnits.createdAt
		})
		.from(hdb.schema.memoryUnits)
		.where(eq(hdb.schema.memoryUnits.bankId, bankId))
		.all()

	const candidateAnchors = candidateRows
		.filter(
			row =>
				row.bankId === bankId && !newMemoryIds.has(row.id)
		)
		.map(row => ({
			id: row.id,
			anchor: getTemporalAnchor(
				row.eventDate,
				row.occurredStart,
				row.occurredEnd,
				row.mentionedAt,
				row.createdAt
			)
		}))
		.filter(
			(row): row is { id: string; anchor: number } =>
				row.anchor != null
		)

	const newUnits: Record<string, number> = {}
	for (const memory of newMemories) {
		const anchor = getTemporalAnchor(
			memory.eventDate,
			memory.occurredStart,
			memory.occurredEnd,
			memory.mentionedAt,
			memory.createdAt
		)
		if (anchor == null) continue
		newUnits[memory.id] = anchor
	}

	const { minDate, maxDate } = computeTemporalQueryBounds(
		newUnits,
		TEMPORAL_LINK_WINDOW_HOURS
	)
	const boundedCandidates =
		minDate == null || maxDate == null
			? []
			: candidateAnchors
					.filter(
						candidate =>
							candidate.anchor >= minDate &&
							candidate.anchor <= maxDate
					)
					.sort((a, b) => b.anchor - a.anchor)
					.map(candidate => ({
						id: candidate.id,
						eventDate: candidate.anchor
					}))

	const temporalLinks = computeTemporalLinks(
		newUnits,
		boundedCandidates,
		TEMPORAL_LINK_WINDOW_HOURS
	)

	for (const [
		sourceId,
		targetId,
		_linkType,
		weight
	] of temporalLinks) {
		insertTemporalLinkIfMissing(
			hdb,
			bankId,
			sourceId,
			targetId,
			weight,
			createdAt,
			output
		)
	}

	for (let i = 0; i < newMemories.length; i++) {
		const source = newMemories[i]!
		const sourceAnchor = getTemporalAnchor(
			source.eventDate,
			source.occurredStart,
			source.occurredEnd,
			source.mentionedAt,
			source.createdAt
		)
		if (sourceAnchor == null) continue

		linkWithinBatchTemporal(
			hdb,
			bankId,
			source,
			sourceAnchor,
			newMemories,
			i + 1,
			windowMs,
			createdAt,
			output
		)
	}
}

// ── Causal links ────────────────────────────────────────────────────────────

export function insertCausalRelations(
	hdb: HindsightDatabase,
	bankId: string,
	sourceId: string,
	factIndex: number,
	groupMemoryIds: string[],
	relations: ExtractedCausalRelation[],
	createdAt: number,
	output: RetainResult['links']
): void {
	for (const relation of relations) {
		if (
			relation.targetIndex < 0 ||
			relation.targetIndex >= factIndex
		)
			continue
		const targetId = groupMemoryIds[relation.targetIndex]
		if (!targetId || sourceId === targetId) continue

		const linkType = relation.relationType ?? 'caused_by'
		hdb.db
			.insert(hdb.schema.memoryLinks)
			.values({
				id: ulid(),
				bankId,
				sourceId,
				targetId,
				linkType,
				weight: relation.strength,
				createdAt
			})
			.onConflictDoNothing()
			.run()

		output.push({ sourceId, targetId, linkType })
	}
}

export function insertCausalLinksForGroup(
	hdb: HindsightDatabase,
	bankId: string,
	groupFacts: PreparedExtractedFact[],
	groupMemoryIds: string[],
	createdAt: number,
	output: RetainResult['links']
): void {
	for (let i = 0; i < groupFacts.length; i++) {
		const sourceId = groupMemoryIds[i]
		const fact = groupFacts[i]
		if (!sourceId || !fact) continue
		insertCausalRelations(
			hdb,
			bankId,
			sourceId,
			i,
			groupMemoryIds,
			fact.fact.causalRelations ?? [],
			createdAt,
			output
		)
	}
}

export function createCausalLinksFromGroups(
	hdb: HindsightDatabase,
	bankId: string,
	facts: PreparedExtractedFact[],
	memoryIdsByGroup: Map<number, string[]>,
	createdAt: number,
	output: RetainResult['links']
): void {
	const factsByGroup = new Map<
		number,
		PreparedExtractedFact[]
	>()
	for (const fact of facts) {
		const list = factsByGroup.get(fact.groupIndex) ?? []
		list.push(fact)
		factsByGroup.set(fact.groupIndex, list)
	}

	for (const [
		groupIndex,
		groupFacts
	] of factsByGroup.entries()) {
		const groupMemoryIds =
			memoryIdsByGroup.get(groupIndex) ?? []
		insertCausalLinksForGroup(
			hdb,
			bankId,
			groupFacts,
			groupMemoryIds,
			createdAt,
			output
		)
	}
}

// ── Semantic links ──────────────────────────────────────────────────────────

export function insertSemanticHitsForMemory(
	hdb: HindsightDatabase,
	bankId: string,
	memoryId: string,
	hits: Array<{ id: string; distance: number }>,
	skipIds: Set<string>,
	createdAt: number,
	output: RetainResult['links']
): void {
	for (const hit of hits) {
		if (hit.id === memoryId || skipIds.has(hit.id)) continue
		const similarity = 1 - hit.distance
		if (similarity < SEMANTIC_LINK_THRESHOLD) continue

		const row = hdb.db
			.select({ bankId: hdb.schema.memoryUnits.bankId })
			.from(hdb.schema.memoryUnits)
			.where(eq(hdb.schema.memoryUnits.id, hit.id))
			.get()
		if (row?.bankId !== bankId) continue

		hdb.db
			.insert(hdb.schema.memoryLinks)
			.values({
				id: ulid(),
				bankId,
				sourceId: memoryId,
				targetId: hit.id,
				linkType: 'semantic',
				weight: similarity,
				createdAt
			})
			.onConflictDoNothing()
			.run()

		output.push({
			sourceId: memoryId,
			targetId: hit.id,
			linkType: 'semantic'
		})
	}
}

export function createSemanticLinksFromVectors(
	hdb: HindsightDatabase,
	memoryVec: EmbeddingStore,
	bankId: string,
	newMemories: Array<{ id: string; vector: Float32Array }>,
	createdAt: number,
	output: RetainResult['links']
): void {
	const newMemoryIds = new Set(
		newMemories.map(memory => memory.id)
	)

	for (const memory of newMemories) {
		const hits = memoryVec.searchByVector(
			memory.vector,
			SEMANTIC_LINK_TOP_K + 1
		)
		insertSemanticHitsForMemory(
			hdb,
			bankId,
			memory.id,
			hits,
			newMemoryIds,
			createdAt,
			output
		)
	}
}

export function insertSemanticLinksFromHits(
	hdb: HindsightDatabase,
	bankId: string,
	memoryId: string,
	hits: Array<{ id: string; distance: number }>,
	skipIds: Set<string>,
	links: RetainResult['links']
): void {
	for (const hit of hits) {
		if (hit.id === memoryId || skipIds.has(hit.id)) continue

		const similarity = 1 - hit.distance
		if (similarity < SEMANTIC_LINK_THRESHOLD) continue

		const memRow = hdb.db
			.select({ bankId: hdb.schema.memoryUnits.bankId })
			.from(hdb.schema.memoryUnits)
			.where(eq(hdb.schema.memoryUnits.id, hit.id))
			.get()
		if (memRow?.bankId !== bankId) continue

		hdb.db
			.insert(hdb.schema.memoryLinks)
			.values({
				id: ulid(),
				bankId,
				sourceId: memoryId,
				targetId: hit.id,
				linkType: 'semantic',
				weight: similarity,
				createdAt: Date.now()
			})
			.onConflictDoNothing()
			.run()

		links.push({
			sourceId: memoryId,
			targetId: hit.id,
			linkType: 'semantic' as LinkType
		})
	}
}

export async function createSemanticLinks(
	hdb: HindsightDatabase,
	memoryVec: EmbeddingStore,
	bankId: string,
	newMemoryIds: string[]
): Promise<RetainResult['links']> {
	const links: RetainResult['links'] = []
	const newIdSet = new Set(newMemoryIds)

	for (const memoryId of newMemoryIds) {
		const row = hdb.db
			.select({ content: hdb.schema.memoryUnits.content })
			.from(hdb.schema.memoryUnits)
			.where(eq(hdb.schema.memoryUnits.id, memoryId))
			.get()
		if (!row) continue

		const hits = await memoryVec.search(
			row.content,
			SEMANTIC_LINK_TOP_K + 1
		)
		insertSemanticLinksFromHits(
			hdb,
			bankId,
			memoryId,
			hits,
			newIdSet,
			links
		)
	}

	return links
}

// ── Utility ─────────────────────────────────────────────────────────────────

export function addUniqueLink(
	result: RetainResult,
	linkKeys: Set<string>,
	link: RetainResult['links'][number]
): void {
	const key = `${link.sourceId}:${link.targetId}:${link.linkType}`
	if (linkKeys.has(key)) return
	linkKeys.add(key)
	result.links.push(link)
}

// ── Co-occurrence helpers ───────────────────────────────────────────────────

/**
 * Load all co-occurrence data for a bank into a Map<entityId, Set<entityId>>.
 */
export function loadCooccurrences(
	hdb: HindsightDatabase,
	bankId: string
): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>()

	const rows = hdb.db
		.select()
		.from(hdb.schema.entityCooccurrences)
		.where(
			eq(hdb.schema.entityCooccurrences.bankId, bankId)
		)
		.all()

	for (const row of rows) {
		if (!map.has(row.entityA))
			map.set(row.entityA, new Set())
		if (!map.has(row.entityB))
			map.set(row.entityB, new Set())
		map.get(row.entityA)!.add(row.entityB)
		map.get(row.entityB)!.add(row.entityA)
	}

	return map
}

/**
 * Update co-occurrence counts for all pairs of entities linked to a memory.
 * Convention: always store smaller ULID first (entityA < entityB).
 */
export function updateCooccurrences(
	hdb: HindsightDatabase,
	bankId: string,
	entityIds: string[]
): void {
	for (let i = 0; i < entityIds.length; i++) {
		for (let j = i + 1; j < entityIds.length; j++) {
			const [entityA, entityB] =
				entityIds[i]! < entityIds[j]!
					? [entityIds[i]!, entityIds[j]!]
					: [entityIds[j]!, entityIds[i]!]

			// Use raw SQL for upsert (ON CONFLICT UPDATE)
			hdb.sqlite.run(
				`INSERT INTO hs_entity_cooccurrences (bank_id, entity_a, entity_b, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (bank_id, entity_a, entity_b)
         DO UPDATE SET count = count + 1`,
				[bankId, entityA, entityB]
			)
		}
	}
}
