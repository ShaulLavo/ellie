import { ulid } from 'fast-ulid'
import { eq } from 'drizzle-orm'
import type { AnyTextAdapter } from '@tanstack/ai'
import type { HindsightDatabase } from './db'
import type { EmbeddingStore } from './embedding'
import type {
	RetainBatchOptions,
	RetainBatchResult,
	RetainBatchItem,
	RetainResult,
	MemoryUnit,
	Entity,
	FactType,
	RerankFunction,
	RetainRoute
} from './types'
import type { RouteDecision } from './types'
import { ftsInsert } from './fts'
import {
	routeFactByVector,
	applyReinforce,
	applyReconsolidate,
	logDecision,
	RECONSOLIDATE_THRESHOLD,
	type RoutingContext
} from './routing'
import { consolidate } from './consolidation'
import type { ReflectFn } from './mental-models'
import {
	resolveEpisode,
	recordEpisodeEvent
} from './episodes'
import { generateFallbackGist } from './context-pack'
import {
	runInTransaction,
	buildContentHash,
	upsertDocuments,
	upsertChunks,
	rowToMemoryUnit,
	scheduleGistUpgrades
} from './retain-db'
import {
	extractFactsFromContent,
	normalizeBatchInputs,
	explodeBatchContents,
	splitByCharacterBudget,
	parseISOToEpoch,
	CHARS_PER_BATCH,
	type PreparedExtractedFact,
	type ExtractedFact
} from './retain-extract'
import {
	planEntities,
	resolveLinkedEntities
} from './retain-entities'
import {
	createEntityLinksFromMemories,
	createCausalLinksFromGroups,
	createTemporalLinksFromMemories,
	createSemanticLinksFromVectors,
	addUniqueLink,
	updateCooccurrences
} from './retain-links'

// ── Types ───────────────────────────────────────────────────────────────────

interface AppliedDecision {
	memoryId: string
	route: RetainRoute
	originalIndex: number
	flatIndex: number
	eventTime: number
	profile: string | null
	project: string | null
	session: string | null
	sourceText: string
}

type MemoryRecordList = Array<{
	memory: MemoryUnit
	originalIndex: number
	fact: ExtractedFact
	vector: Float32Array
	flatIndex: number
	profile: string | null
	project: string | null
	session: string | null
	sourceText: string
}>

// ── Decision application ────────────────────────────────────────────────────

async function applyDecisionAction(
	hdb: HindsightDatabase,
	memoryVec: EmbeddingStore,
	bankId: string,
	decision: RouteDecision,
	item: PreparedExtractedFact,
	flatIndex: number,
	eventTime: number,
	now: number
): Promise<AppliedDecision | null> {
	if (
		decision.route === 'reinforce' &&
		decision.candidateMemoryId
	) {
		runInTransaction(hdb, () => {
			applyReinforce(hdb, decision.candidateMemoryId!, now)
			logDecision(
				hdb,
				bankId,
				decision,
				decision.candidateMemoryId!,
				now
			)
		})
		return {
			memoryId: decision.candidateMemoryId,
			route: 'reinforce',
			originalIndex: item.originalIndex,
			flatIndex,
			eventTime,
			profile: item.profile,
			project: item.project,
			session: item.session,
			sourceText: item.fact.content
		}
	}
	if (
		decision.route === 'reconsolidate' &&
		decision.candidateMemoryId
	) {
		await applyReconsolidate(
			hdb,
			memoryVec,
			decision.candidateMemoryId,
			item.fact.content,
			item.fact.entities,
			`Reconsolidated: score=${decision.candidateScore?.toFixed(3)}`,
			now
		)
		runInTransaction(hdb, () => {
			logDecision(
				hdb,
				bankId,
				decision,
				decision.candidateMemoryId!,
				now
			)
		})
		return {
			memoryId: decision.candidateMemoryId,
			route: 'reconsolidate',
			originalIndex: item.originalIndex,
			flatIndex,
			eventTime,
			profile: item.profile,
			project: item.project,
			session: item.session,
			sourceText: item.fact.content
		}
	}
	return null
}

// ── Batch new-trace processing ──────────────────────────────────────────────

/**
 * Process all new_trace facts in a batch sub-group: plan entities, build memory
 * rows, write everything to DB in a single transaction (entities, memories, FTS,
 * embeddings, junctions, links), distribute results into the per-input
 * aggregates, and log routing decisions.
 *
 * Extracted from the `retainBatch` inner loop for readability.
 */
async function processNewTraceMemories(ctx: {
	hdb: HindsightDatabase
	bankId: string
	retainedFacts: PreparedExtractedFact[]
	retainedVectors: Float32Array[]
	newTraceDecisionIndices: number[]
	batchDecisions: RouteDecision[]
	entityVec: EmbeddingStore
	memoryVec: EmbeddingStore
	now: number
	// Mutable accumulators from outer scope
	entityById: Map<string, Entity>
	entityIdsByResult: Set<string>[]
	mentionOffsetsByResult: number[]
	aggregate: RetainResult[]
	linkKeysByResult: Set<string>[]
	memoryIdsToOriginalIndex: Map<string, number>
}): Promise<MemoryRecordList> {
	const {
		hdb,
		bankId,
		retainedFacts,
		retainedVectors,
		newTraceDecisionIndices,
		batchDecisions,
		entityVec,
		memoryVec,
		now,
		entityById,
		entityIdsByResult,
		mentionOffsetsByResult,
		aggregate,
		linkKeysByResult,
		memoryIdsToOriginalIndex
	} = ctx

	const entityPlan = planEntities(
		hdb,
		bankId,
		retainedFacts,
		now
	)
	for (const [
		entityId,
		entity
	] of entityPlan.entityById.entries()) {
		entityById.set(entityId, entity)
	}
	const entityVectors = await entityVec.createVectors(
		entityPlan.newEntities.map(entity => entity.name)
	)

	const memoryRows: Array<
		typeof hdb.schema.memoryUnits.$inferInsert
	> = []
	const memoryEntityIds = new Map<string, string[]>()
	const memoryEntityNames = new Map<string, Set<string>>()
	const memoryIdsByGroup = new Map<number, string[]>()
	const memoryRecords: MemoryRecordList = []

	for (let i = 0; i < retainedFacts.length; i++) {
		const item = retainedFacts[i]!
		const memoryId = ulid()
		const tags = [
			...new Set([...(item.fact.tags ?? []), ...item.tags])
		]
		const offset =
			mentionOffsetsByResult[item.originalIndex] ?? 0
		mentionOffsetsByResult[item.originalIndex] = offset + 1
		const mentionedAt = item.eventDateMs + offset
		const occurredStart = parseISOToEpoch(
			item.fact.occurredStart ?? item.fact.occurredStart
		)
		const occurredEnd = parseISOToEpoch(
			item.fact.occurredEnd ?? item.fact.occurredEnd
		)
		const eventDate = occurredStart ?? mentionedAt
		const sourceText = item.context
			? `${item.context}\n\n${item.sourceText}`
			: item.sourceText

		memoryRows.push({
			id: memoryId,
			bankId,
			documentId: item.documentId,
			chunkId: item.chunkId,
			content: item.fact.content,
			factType: item.fact.factType,
			confidence: item.fact.confidence,
			eventDate,
			occurredStart,
			occurredEnd,
			mentionedAt,
			metadata: item.metadata
				? JSON.stringify(item.metadata)
				: null,
			tags: tags.length > 0 ? JSON.stringify(tags) : null,
			sourceText,
			accessCount: 0,
			lastAccessed: null,
			encodingStrength: 1.0,
			gist: generateFallbackGist(item.fact.content),
			scopeProfile: item.profile ?? null,
			scopeProject: item.project ?? null,
			scopeSession: item.session ?? null,
			createdAt: now,
			updatedAt: now
		})

		const memory: MemoryUnit = {
			id: memoryId,
			bankId,
			content: item.fact.content,
			factType: item.fact.factType as FactType,
			confidence: item.fact.confidence,
			documentId: item.documentId,
			chunkId: item.chunkId,
			eventDate,
			occurredStart,
			occurredEnd,
			mentionedAt,
			metadata: item.metadata,
			tags: tags.length > 0 ? tags : null,
			sourceText,
			consolidatedAt: null,
			proofCount: 0,
			sourceMemoryIds: null,
			history: null,
			createdAt: now,
			updatedAt: now
		}

		const { linkedEntityIds, linkedEntityNames } =
			resolveLinkedEntities(
				item.fact.entities,
				entityPlan.entityMap,
				entityIdsByResult[item.originalIndex]!
			)

		memoryEntityIds.set(memoryId, linkedEntityIds)
		memoryEntityNames.set(memoryId, linkedEntityNames)
		memoryRecords.push({
			memory,
			originalIndex: item.originalIndex,
			fact: item.fact,
			vector: retainedVectors[i]!,
			flatIndex: newTraceDecisionIndices[i]!,
			profile: item.profile,
			project: item.project,
			session: item.session,
			sourceText: item.fact.content
		})
		const groupMemoryIds =
			memoryIdsByGroup.get(item.groupIndex) ?? []
		groupMemoryIds.push(memoryId)
		memoryIdsByGroup.set(item.groupIndex, groupMemoryIds)
		memoryIdsToOriginalIndex.set(
			memoryId,
			item.originalIndex
		)
	}

	const existingById = new Map(
		hdb.db
			.select()
			.from(hdb.schema.entities)
			.where(eq(hdb.schema.entities.bankId, bankId))
			.all()
			.map(row => [row.id, row])
	)

	const createdLinks: RetainResult['links'] = []

	runInTransaction(hdb, () => {
		for (const [
			entityId,
			delta
		] of entityPlan.existingMentionDeltas.entries()) {
			const existing = existingById.get(entityId)
			if (!existing) continue
			hdb.db
				.update(hdb.schema.entities)
				.set({
					lastUpdated: now,
					mentionCount: existing.mentionCount + delta
				})
				.where(eq(hdb.schema.entities.id, entityId))
				.run()
		}

		for (const newEntity of entityPlan.newEntities) {
			hdb.db
				.insert(hdb.schema.entities)
				.values(newEntity)
				.run()
		}

		entityVec.upsertVectors(
			entityPlan.newEntities.map((entity, index) => ({
				id: entity.id,
				vector: entityVectors[index]!
			}))
		)

		for (const row of memoryRows) {
			hdb.db
				.insert(hdb.schema.memoryUnits)
				.values(row)
				.run()
			ftsInsert(hdb, row.id, bankId, row.content)
		}

		memoryVec.upsertVectors(
			memoryRecords.map(item => ({
				id: item.memory.id,
				vector: item.vector
			}))
		)

		for (const memory of memoryRecords) {
			const linkedEntityIds =
				memoryEntityIds.get(memory.memory.id) ?? []
			for (const entityId of linkedEntityIds) {
				hdb.db
					.insert(hdb.schema.memoryEntities)
					.values({ memoryId: memory.memory.id, entityId })
					.run()
			}
			updateCooccurrences(hdb, bankId, linkedEntityIds)
		}

		createEntityLinksFromMemories(
			hdb,
			bankId,
			memoryRecords.map(record => record.memory.id),
			memoryEntityNames,
			now,
			createdLinks
		)

		createCausalLinksFromGroups(
			hdb,
			bankId,
			retainedFacts,
			memoryIdsByGroup,
			now,
			createdLinks
		)

		createTemporalLinksFromMemories(
			hdb,
			bankId,
			memoryRecords.map(record => record.memory),
			now,
			createdLinks
		)

		createSemanticLinksFromVectors(
			hdb,
			memoryVec,
			bankId,
			memoryRecords.map(record => ({
				id: record.memory.id,
				vector: record.vector
			})),
			now,
			createdLinks
		)
	})

	for (const memory of memoryRecords) {
		aggregate[memory.originalIndex]!.memories.push(
			memory.memory
		)
	}

	for (const link of createdLinks) {
		const sourceIndex = memoryIdsToOriginalIndex.get(
			link.sourceId
		)
		const targetIndex = memoryIdsToOriginalIndex.get(
			link.targetId
		)
		if (sourceIndex !== undefined) {
			addUniqueLink(
				aggregate[sourceIndex]!,
				linkKeysByResult[sourceIndex]!,
				link
			)
		}
		if (
			targetIndex !== undefined &&
			targetIndex !== sourceIndex
		) {
			addUniqueLink(
				aggregate[targetIndex]!,
				linkKeysByResult[targetIndex]!,
				link
			)
		}
	}

	// Log new_trace decisions
	for (let i = 0; i < memoryRecords.length; i++) {
		const flatIdx = newTraceDecisionIndices[i]
		if (flatIdx !== undefined) {
			logDecision(
				hdb,
				bankId,
				batchDecisions[flatIdx]!,
				memoryRecords[i]!.memory.id,
				now
			)
		}
	}

	return memoryRecords
}

// ── Main batch function ─────────────────────────────────────────────────────

export async function retainBatch(
	hdb: HindsightDatabase,
	memoryVec: EmbeddingStore,
	entityVec: EmbeddingStore,
	modelVec: EmbeddingStore,
	adapter: AnyTextAdapter,
	bankId: string,
	contents: string[] | RetainBatchItem[],
	reflectFn: ReflectFn,
	options: RetainBatchOptions = {},
	rerank?: RerankFunction
): Promise<RetainBatchResult> {
	if (contents.length === 0) return []
	const normalizedItems = normalizeBatchInputs(
		bankId,
		contents,
		options
	)
	if (normalizedItems.length === 0) return []

	const expandedContents = await explodeBatchContents(
		bankId,
		normalizedItems
	)
	const subBatches = splitByCharacterBudget(
		expandedContents,
		CHARS_PER_BATCH
	)
	const aggregate = normalizedItems.map<RetainResult>(
		() => ({
			memories: [],
			entities: [],
			links: []
		})
	)
	const entityIdsByResult = normalizedItems.map(
		() => new Set<string>()
	)
	const entityById = new Map<string, Entity>()
	const linkKeysByResult = normalizedItems.map(
		() => new Set<string>()
	)
	const memoryIdsToOriginalIndex = new Map<string, number>()
	const mentionOffsetsByResult = normalizedItems.map(
		() => 0
	)

	const now = Date.now()
	const dedupThreshold = options.dedupThreshold ?? 0
	const documentRows: Array<
		typeof hdb.schema.documents.$inferInsert
	> = normalizedItems.map(item => ({
		id: item.documentId,
		bankId,
		originalText: item.content,
		contentHash: buildContentHash(item.content),
		metadata: item.metadata
			? JSON.stringify(item.metadata)
			: null,
		retainParams: JSON.stringify({
			context: item.context ?? undefined,
			eventDate: item.eventDateMs
		}),
		tags:
			item.tags.length > 0
				? JSON.stringify(item.tags)
				: null,
		createdAt: now,
		updatedAt: now
	}))
	const chunkRows: Array<
		typeof hdb.schema.chunks.$inferInsert
	> = expandedContents.map(item => ({
		id: item.chunkId,
		documentId: item.documentId,
		bankId,
		content: item.content,
		chunkIndex: item.chunkIndex,
		createdAt: now
	}))

	runInTransaction(hdb, () => {
		upsertDocuments(hdb, documentRows)
		upsertChunks(hdb, chunkRows)
	})

	for (const subBatch of subBatches) {
		const extractedPerContent = await Promise.all(
			subBatch.map(
				async ({
					content,
					context,
					eventDateMs,
					chunkIndex,
					chunkCount
				}) =>
					extractFactsFromContent(
						adapter,
						content,
						options,
						context,
						eventDateMs,
						chunkIndex,
						chunkCount
					)
			)
		)

		const flattened: PreparedExtractedFact[] = []
		for (
			let groupIndex = 0;
			groupIndex < subBatch.length;
			groupIndex++
		) {
			const item = subBatch[groupIndex]!
			const extracted = extractedPerContent[groupIndex]!
			for (const fact of extracted) {
				flattened.push({
					fact,
					originalIndex: item.originalIndex,
					groupIndex,
					sourceText: item.content,
					context: item.context,
					eventDateMs: item.eventDateMs,
					documentId: item.documentId,
					chunkId: item.chunkId,
					metadata: item.metadata,
					tags: item.tags,
					profile: item.profile,
					project: item.project,
					session: item.session
				})
			}
		}

		if (flattened.length === 0) continue

		const allVectors = await memoryVec.createVectors(
			flattened.map(item => item.fact.content)
		)

		// ── Route each fact via reconsolidation engine ──
		const batchDecisions: RouteDecision[] = []
		const batchAppliedMemoryIds: AppliedDecision[] = []

		for (let i = 0; i < flattened.length; i++) {
			if (dedupThreshold <= 0) {
				batchDecisions.push({
					route: 'new_trace',
					candidateMemoryId: null,
					candidateScore: null,
					conflictDetected: false,
					conflictKeys: []
				})
				continue
			}
			const item = flattened[i]!
			const routingCtx: RoutingContext = {
				hdb,
				memoryVec,
				bankId,
				eventTime: item.eventDateMs + i,
				profile: item.profile,
				project: item.project
			}
			const decision = routeFactByVector(
				routingCtx,
				item.fact.entities,
				allVectors[i]!,
				{
					reinforceThreshold: dedupThreshold,
					reconsolidateThreshold: Math.min(
						RECONSOLIDATE_THRESHOLD,
						dedupThreshold
					)
				}
			)
			batchDecisions.push(decision)
		}

		// Apply reinforce and reconsolidate actions
		for (let i = 0; i < flattened.length; i++) {
			const decision = batchDecisions[i]!
			const item = flattened[i]!
			const eventTime = item.eventDateMs + i
			const applied = await applyDecisionAction(
				hdb,
				memoryVec,
				bankId,
				decision,
				item,
				i,
				eventTime,
				now
			)
			if (applied) batchAppliedMemoryIds.push(applied)
		}

		// Filter to only new_trace facts for the insert pipeline
		const retainedFacts: PreparedExtractedFact[] = []
		const retainedVectors: Float32Array[] = []
		const newTraceDecisionIndices: number[] = []
		for (let i = 0; i < flattened.length; i++) {
			if (batchDecisions[i]!.route !== 'new_trace') continue
			retainedFacts.push(flattened[i]!)
			retainedVectors.push(allVectors[i]!)
			newTraceDecisionIndices.push(i)
		}

		// Load reinforced/reconsolidated memories into aggregate results
		for (const {
			memoryId,
			originalIndex
		} of batchAppliedMemoryIds) {
			const row = hdb.db
				.select()
				.from(hdb.schema.memoryUnits)
				.where(eq(hdb.schema.memoryUnits.id, memoryId))
				.get()
			if (row) {
				aggregate[originalIndex]!.memories.push(
					rowToMemoryUnit(row)
				)
			}
		}

		if (
			retainedFacts.length === 0 &&
			batchAppliedMemoryIds.length === 0
		)
			continue

		let memoryRecords: MemoryRecordList = []

		if (retainedFacts.length > 0) {
			memoryRecords = await processNewTraceMemories({
				hdb,
				bankId,
				retainedFacts,
				retainedVectors,
				newTraceDecisionIndices,
				batchDecisions,
				entityVec,
				memoryVec,
				now,
				entityById,
				entityIdsByResult,
				mentionOffsetsByResult,
				aggregate,
				linkKeysByResult,
				memoryIdsToOriginalIndex
			})
		}

		// ── Episode tracking ──

		for (const applied of batchAppliedMemoryIds) {
			const episodeId = resolveEpisode(
				hdb,
				bankId,
				applied.eventTime,
				applied.profile,
				applied.project,
				applied.session,
				applied.sourceText
			)
			recordEpisodeEvent(
				hdb,
				episodeId,
				bankId,
				applied.memoryId,
				applied.route,
				applied.eventTime,
				applied.profile,
				applied.project,
				applied.session
			)
		}
		for (const record of memoryRecords) {
			const eventTime =
				record.memory.mentionedAt ??
				record.memory.eventDate ??
				Date.now()
			const episodeId = resolveEpisode(
				hdb,
				bankId,
				eventTime,
				record.profile,
				record.project,
				record.session,
				record.sourceText
			)
			recordEpisodeEvent(
				hdb,
				episodeId,
				bankId,
				record.memory.id,
				'new_trace',
				eventTime,
				record.profile,
				record.project,
				record.session
			)
		}
	}

	for (let i = 0; i < aggregate.length; i++) {
		aggregate[i]!.entities = [...entityIdsByResult[i]!]
			.map(entityId => entityById.get(entityId))
			.filter((entity): entity is Entity => Boolean(entity))
	}

	if (options.consolidate !== false) {
		consolidate(
			hdb,
			memoryVec,
			modelVec,
			adapter,
			bankId,
			reflectFn,
			{},
			rerank
		).catch(() => {
			// consolidation is best-effort
		})
	}

	// Fire-and-forget LLM gist generation for batch memories
	const allBatchMemories = aggregate.flatMap(
		r => r.memories
	)
	scheduleGistUpgrades(
		adapter,
		hdb,
		hdb.schema,
		allBatchMemories
	)

	return aggregate
}
