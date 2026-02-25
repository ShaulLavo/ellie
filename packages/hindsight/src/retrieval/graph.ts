import { and, eq, gte, inArray, or } from 'drizzle-orm'
import type { HindsightDatabase } from '../db'
import type { EmbeddingStore } from '../embedding'
import type { FactType, TagsMatch } from '../types'
import { passesTagFilter, parseStringArray } from '../tags'
import type { RetrievalHit } from './semantic'

/**
 * LinkExpansion graph retrieval.
 *
 * Expands from semantic seeds via:
 * 1) entity links (with mention-count frequency filtering)
 * 2) causal links (directional: causes/caused_by/enables/prevents)
 * 3) observation traversal through source_memory_ids
 *
 * Observation traversal path:
 *   seed observation -> source memories -> entities -> connected sources -> observations
 */
export async function searchGraph(
	hdb: HindsightDatabase,
	memoryVec: EmbeddingStore,
	bankId: string,
	query: string,
	limit: number,
	options: GraphSearchOptions = {}
): Promise<RetrievalHit[]> {
	if (limit <= 0) return []

	const seedIds = await resolveSeedIds(hdb, memoryVec, bankId, query, limit, options)
	if (seedIds.length === 0) return []

	const seedSet = new Set(seedIds)
	const entityScores = expandViaEntities(hdb, bankId, seedIds, seedSet, options)
	const causalScores = expandViaCausalLinks(hdb, bankId, seedIds, seedSet, options)
	const fallbackScores = expandViaFallbackLinks(hdb, bankId, seedIds, seedSet, limit, options)
	const merged = mergeScoreMaps(mergeScoreMaps(entityScores, causalScores), fallbackScores)
	const filtered = filterOutSeeds(merged, seedSet)

	return Array.from(filtered.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([id, score]) => ({ id, score, source: 'graph' }))
}

export interface GraphSearchOptions {
	factTypes?: FactType[]
	tags?: string[]
	tagsMatch?: TagsMatch
	maxEntityFrequency?: number
	causalWeightThreshold?: number
	causalLimitPerSeed?: number
	seedLimit?: number
	seedThreshold?: number
	/** Test hook: bypass semantic seed lookup when provided. */
	seedMemoryIds?: string[]
	/** Optional temporal seeds merged with semantic seeds. */
	temporalSeedMemoryIds?: string[]
}

// Python parity: only "caused_by" is a valid causal relation type.
const CAUSAL_LINK_TYPES = ['caused_by'] as const
const FALLBACK_LINK_TYPES = ['semantic', 'temporal', 'entity'] as const
const ALL_FACT_TYPES: FactType[] = ['world', 'experience', 'opinion', 'observation']
const DEFAULT_MAX_ENTITY_FREQUENCY = 500
const DEFAULT_CAUSAL_WEIGHT_THRESHOLD = 0.3
const DEFAULT_CAUSAL_LIMIT_PER_SEED = 10
const DEFAULT_SEED_LIMIT = 20
const DEFAULT_SEED_THRESHOLD = 0.3

async function resolveSeedIds(
	hdb: HindsightDatabase,
	memoryVec: EmbeddingStore,
	bankId: string,
	query: string,
	limit: number,
	options: GraphSearchOptions
): Promise<string[]> {
	if (options.seedMemoryIds?.length) {
		return unique([...options.seedMemoryIds, ...(options.temporalSeedMemoryIds ?? [])])
	}

	const desiredSeedCount = Math.max(
		1,
		Math.min(options.seedLimit ?? DEFAULT_SEED_LIMIT, Math.max(limit, 1))
	)
	const searchLimit = desiredSeedCount * 4
	const seedThreshold = options.seedThreshold ?? DEFAULT_SEED_THRESHOLD
	const factTypes = getFactTypeSet(options.factTypes)
	const hits = await memoryVec.search(query, searchLimit)

	// Filter hits above threshold (preserving order)
	const candidateHits = hits.filter((hit) => {
		const similarity = 1 - hit.distance
		return similarity >= seedThreshold
	})

	// Collect all IDs we need to look up (semantic hits + temporal seeds)
	const temporalSeedIds = unique(options.temporalSeedMemoryIds ?? [])
	const allCandidateIds = unique([...candidateHits.map((h) => h.id), ...temporalSeedIds])

	// Batch-load all candidate memory rows in one query
	const candidateRows =
		allCandidateIds.length > 0
			? hdb.db
					.select({
						id: hdb.schema.memoryUnits.id,
						bankId: hdb.schema.memoryUnits.bankId,
						factType: hdb.schema.memoryUnits.factType,
						tags: hdb.schema.memoryUnits.tags
					})
					.from(hdb.schema.memoryUnits)
					.where(inArray(hdb.schema.memoryUnits.id, allCandidateIds))
					.all()
			: []
	const rowById = new Map(candidateRows.map((r) => [r.id, r]))

	// Select seeds from semantic hits (order matters — best similarity first)
	const seeds: string[] = []
	const seen = new Set<string>()

	for (const hit of candidateHits) {
		if (seeds.length >= desiredSeedCount) break
		if (seen.has(hit.id)) continue

		const row = rowById.get(hit.id)
		if (!row || row.bankId !== bankId) continue
		if (!factTypes.has(row.factType as FactType)) continue
		if (!passesTagFilter(row.tags, options.tags, options.tagsMatch)) continue

		seen.add(hit.id)
		seeds.push(hit.id)
	}

	// Add temporal seeds
	for (const temporalSeedId of temporalSeedIds) {
		if (seen.has(temporalSeedId)) continue

		const row = rowById.get(temporalSeedId)
		if (!row || row.bankId !== bankId) continue
		if (!factTypes.has(row.factType as FactType)) continue
		if (!passesTagFilter(row.tags, options.tags, options.tagsMatch)) continue

		seen.add(temporalSeedId)
		seeds.push(temporalSeedId)
	}

	return seeds
}

function expandViaEntities(
	hdb: HindsightDatabase,
	bankId: string,
	seedIds: string[],
	seedSet: Set<string>,
	options: GraphSearchOptions
): Map<string, number> {
	const entityIds = getRelevantEntityIds(hdb, bankId, seedIds, options)
	if (entityIds.length === 0) return new Map()

	const directScores = scoreDirectEntityExpansion(hdb, bankId, entityIds, seedSet, options)
	const observationScores = scoreObservationEntityExpansion(
		hdb,
		bankId,
		seedIds,
		entityIds,
		seedSet,
		options
	)
	return mergeScoreMaps(directScores, observationScores)
}

function getRelevantEntityIds(
	hdb: HindsightDatabase,
	bankId: string,
	seedIds: string[],
	options: GraphSearchOptions
): string[] {
	const directEntityIds = getEntityIdsForMemoryIds(hdb, seedIds)
	const observationSourceIds = getObservationSourceIds(hdb, bankId, seedIds)
	const sourceEntityIds = getEntityIdsForMemoryIds(hdb, observationSourceIds)
	const allEntityIds = unique([...directEntityIds, ...sourceEntityIds])
	if (allEntityIds.length === 0) return []

	const maxEntityFrequency = options.maxEntityFrequency ?? DEFAULT_MAX_ENTITY_FREQUENCY
	const rows = hdb.db
		.select({
			id: hdb.schema.entities.id,
			mentionCount: hdb.schema.entities.mentionCount,
			bankId: hdb.schema.entities.bankId
		})
		.from(hdb.schema.entities)
		.where(inArray(hdb.schema.entities.id, allEntityIds))
		.all()

	return rows
		.filter((r) => r.bankId === bankId && r.mentionCount < maxEntityFrequency)
		.map((r) => r.id)
}

function getEntityIdsForMemoryIds(hdb: HindsightDatabase, memoryIds: string[]): string[] {
	if (memoryIds.length === 0) return []

	const rows = hdb.db
		.select({
			entityId: hdb.schema.memoryEntities.entityId
		})
		.from(hdb.schema.memoryEntities)
		.where(inArray(hdb.schema.memoryEntities.memoryId, memoryIds))
		.all()

	return unique(rows.map((r) => r.entityId))
}

function scoreDirectEntityExpansion(
	hdb: HindsightDatabase,
	bankId: string,
	entityIds: string[],
	seedSet: Set<string>,
	options: GraphSearchOptions
): Map<string, number> {
	if (!shouldSearchDirectFactTypes(options.factTypes)) return new Map()
	if (entityIds.length === 0) return new Map()

	const relations = hdb.db
		.select({
			memoryId: hdb.schema.memoryEntities.memoryId
		})
		.from(hdb.schema.memoryEntities)
		.where(inArray(hdb.schema.memoryEntities.entityId, entityIds))
		.all()

	const scores = new Map<string, number>()
	for (const relation of relations) {
		if (seedSet.has(relation.memoryId)) continue
		const current = scores.get(relation.memoryId) ?? 0
		scores.set(relation.memoryId, current + 1)
	}

	return filterScoreMapByMemoryRows(
		hdb,
		bankId,
		scores,
		getFactTypeSet(options.factTypes),
		options.tags,
		options.tagsMatch
	)
}

function scoreObservationEntityExpansion(
	hdb: HindsightDatabase,
	bankId: string,
	seedIds: string[],
	entityIds: string[],
	seedSet: Set<string>,
	options: GraphSearchOptions
): Map<string, number> {
	if (!shouldSearchObservationFactType(options.factTypes)) return new Map()
	if (entityIds.length === 0) return new Map()

	const seedSourceIds = getObservationSourceIds(hdb, bankId, seedIds)
	if (seedSourceIds.length === 0) return new Map()

	const connectedSourceIds = getConnectedSourceIds(hdb, bankId, entityIds)
	if (connectedSourceIds.length === 0) return new Map()

	const sourceIdSet = new Set(connectedSourceIds)
	const observationRows = hdb.db
		.select({
			id: hdb.schema.memoryUnits.id,
			tags: hdb.schema.memoryUnits.tags,
			sourceMemoryIds: hdb.schema.memoryUnits.sourceMemoryIds
		})
		.from(hdb.schema.memoryUnits)
		.where(
			and(
				eq(hdb.schema.memoryUnits.bankId, bankId),
				eq(hdb.schema.memoryUnits.factType, 'observation')
			)
		)
		.all()

	const scores = new Map<string, number>()

	for (const row of observationRows) {
		if (seedSet.has(row.id)) continue
		if (!passesTagFilter(row.tags, options.tags, options.tagsMatch)) continue

		const sourceIds = parseStringArray(row.sourceMemoryIds)
		const overlap = countOverlap(sourceIds, sourceIdSet)
		if (overlap === 0) continue

		const current = scores.get(row.id) ?? 0
		scores.set(row.id, current + overlap)
	}

	return scores
}

function getObservationSourceIds(
	hdb: HindsightDatabase,
	bankId: string,
	memoryIds: string[]
): string[] {
	if (memoryIds.length === 0) return []

	const rows = hdb.db
		.select({
			sourceMemoryIds: hdb.schema.memoryUnits.sourceMemoryIds
		})
		.from(hdb.schema.memoryUnits)
		.where(
			and(
				inArray(hdb.schema.memoryUnits.id, memoryIds),
				eq(hdb.schema.memoryUnits.bankId, bankId),
				eq(hdb.schema.memoryUnits.factType, 'observation')
			)
		)
		.all()

	const sourceIds = rows.flatMap((row) => parseStringArray(row.sourceMemoryIds))
	return unique(sourceIds)
}

function getConnectedSourceIds(
	hdb: HindsightDatabase,
	bankId: string,
	entityIds: string[]
): string[] {
	if (entityIds.length === 0) return []

	const sourceRelations = hdb.db
		.select({
			memoryId: hdb.schema.memoryEntities.memoryId
		})
		.from(hdb.schema.memoryEntities)
		.where(inArray(hdb.schema.memoryEntities.entityId, entityIds))
		.all()

	const candidateIds = unique(sourceRelations.map((r) => r.memoryId))
	if (candidateIds.length === 0) return []

	const rows = hdb.db
		.select({
			id: hdb.schema.memoryUnits.id,
			bankId: hdb.schema.memoryUnits.bankId
		})
		.from(hdb.schema.memoryUnits)
		.where(inArray(hdb.schema.memoryUnits.id, candidateIds))
		.all()

	return rows.filter((row) => row.bankId === bankId).map((row) => row.id)
}

function expandViaCausalLinks(
	hdb: HindsightDatabase,
	bankId: string,
	seedIds: string[],
	seedSet: Set<string>,
	options: GraphSearchOptions
): Map<string, number> {
	if (seedIds.length === 0) return new Map()

	const causalThreshold = options.causalWeightThreshold ?? DEFAULT_CAUSAL_WEIGHT_THRESHOLD
	const perSeedLimit = options.causalLimitPerSeed ?? DEFAULT_CAUSAL_LIMIT_PER_SEED
	const rawLimit = Math.max(1, seedIds.length * perSeedLimit)

	const links = hdb.db
		.select({
			sourceId: hdb.schema.memoryLinks.sourceId,
			targetId: hdb.schema.memoryLinks.targetId,
			weight: hdb.schema.memoryLinks.weight
		})
		.from(hdb.schema.memoryLinks)
		.where(
			and(
				eq(hdb.schema.memoryLinks.bankId, bankId),
				inArray(hdb.schema.memoryLinks.linkType, [...CAUSAL_LINK_TYPES]),
				gte(hdb.schema.memoryLinks.weight, causalThreshold),
				or(
					inArray(hdb.schema.memoryLinks.sourceId, seedIds),
					inArray(hdb.schema.memoryLinks.targetId, seedIds)
				)
			)
		)
		.all()
		.sort((a, b) => b.weight - a.weight)
		.slice(0, rawLimit)

	const scores = new Map<string, number>()

	for (const link of links) {
		if (seedSet.has(link.sourceId) && !seedSet.has(link.targetId)) {
			const current = scores.get(link.targetId) ?? 0
			scores.set(link.targetId, Math.max(current, link.weight + 1))
			continue
		}
		if (seedSet.has(link.targetId) && !seedSet.has(link.sourceId)) {
			const current = scores.get(link.sourceId) ?? 0
			scores.set(link.sourceId, Math.max(current, link.weight + 1))
		}
	}

	return filterScoreMapByMemoryRows(
		hdb,
		bankId,
		scores,
		getFactTypeSet(options.factTypes),
		options.tags,
		options.tagsMatch
	)
}

function expandViaFallbackLinks(
	hdb: HindsightDatabase,
	bankId: string,
	seedIds: string[],
	seedSet: Set<string>,
	limit: number,
	options: GraphSearchOptions
): Map<string, number> {
	if (seedIds.length === 0 || limit <= 0) return new Map()

	const threshold = options.causalWeightThreshold ?? DEFAULT_CAUSAL_WEIGHT_THRESHOLD
	const perSeedLimit = options.causalLimitPerSeed ?? DEFAULT_CAUSAL_LIMIT_PER_SEED
	const rawLimit = Math.max(1, limit * perSeedLimit)

	const links = hdb.db
		.select({
			sourceId: hdb.schema.memoryLinks.sourceId,
			targetId: hdb.schema.memoryLinks.targetId,
			weight: hdb.schema.memoryLinks.weight
		})
		.from(hdb.schema.memoryLinks)
		.where(
			and(
				eq(hdb.schema.memoryLinks.bankId, bankId),
				inArray(hdb.schema.memoryLinks.linkType, [...FALLBACK_LINK_TYPES]),
				gte(hdb.schema.memoryLinks.weight, threshold),
				or(
					inArray(hdb.schema.memoryLinks.sourceId, seedIds),
					inArray(hdb.schema.memoryLinks.targetId, seedIds)
				)
			)
		)
		.all()
		.sort((a, b) => b.weight - a.weight)
		.slice(0, rawLimit)

	const scores = new Map<string, number>()

	for (const link of links) {
		if (seedSet.has(link.sourceId) && !seedSet.has(link.targetId)) {
			const current = scores.get(link.targetId) ?? 0
			scores.set(link.targetId, Math.max(current, link.weight * 0.5))
			continue
		}
		if (seedSet.has(link.targetId) && !seedSet.has(link.sourceId)) {
			const current = scores.get(link.sourceId) ?? 0
			scores.set(link.sourceId, Math.max(current, link.weight * 0.5))
		}
	}

	return filterScoreMapByMemoryRows(
		hdb,
		bankId,
		scores,
		getFactTypeSet(options.factTypes),
		options.tags,
		options.tagsMatch
	)
}

function filterOutSeeds(scores: Map<string, number>, seedSet: Set<string>): Map<string, number> {
	const filtered = new Map<string, number>()
	for (const [id, score] of scores) {
		if (!seedSet.has(id)) {
			filtered.set(id, score)
		}
	}
	return filtered
}

function mergeScoreMaps(
	first: Map<string, number>,
	second: Map<string, number>
): Map<string, number> {
	const merged = new Map(first)

	for (const [id, score] of second.entries()) {
		const current = merged.get(id) ?? 0
		merged.set(id, Math.max(current, score))
	}

	return merged
}

function getFactTypeSet(factTypes?: FactType[]): Set<FactType> {
	return new Set(factTypes && factTypes.length > 0 ? factTypes : ALL_FACT_TYPES)
}

function shouldSearchObservationFactType(factTypes?: FactType[]): boolean {
	if (!factTypes || factTypes.length === 0) return true
	return factTypes.includes('observation')
}

function shouldSearchDirectFactTypes(factTypes?: FactType[]): boolean {
	if (!factTypes || factTypes.length === 0) return true
	return factTypes.some((factType) => factType !== 'observation')
}

function countOverlap(values: string[], lookup: Set<string>): number {
	let count = 0
	for (const value of values) {
		if (lookup.has(value)) count++
	}
	return count
}

function filterScoreMapByMemoryRows(
	hdb: HindsightDatabase,
	bankId: string,
	scores: Map<string, number>,
	factTypeSet: Set<FactType>,
	tags?: string[],
	tagsMatch?: TagsMatch
): Map<string, number> {
	if (scores.size === 0) return scores

	const ids = [...scores.keys()]
	const rows = hdb.db
		.select({
			id: hdb.schema.memoryUnits.id,
			bankId: hdb.schema.memoryUnits.bankId,
			factType: hdb.schema.memoryUnits.factType,
			tags: hdb.schema.memoryUnits.tags
		})
		.from(hdb.schema.memoryUnits)
		.where(inArray(hdb.schema.memoryUnits.id, ids))
		.all()

	const filtered = new Map<string, number>()
	for (const row of rows) {
		if (row.bankId !== bankId) continue
		if (!factTypeSet.has(row.factType as FactType)) continue
		if (!passesTagFilter(row.tags, tags, tagsMatch)) continue
		const score = scores.get(row.id)
		if (score != null) filtered.set(row.id, score)
	}

	return filtered
}

function unique(values: string[]): string[] {
	return [...new Set(values)]
}
