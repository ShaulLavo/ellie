import { ulid } from 'fast-ulid'
import { eq } from 'drizzle-orm'
import type { AnyTextAdapter } from '@tanstack/ai'
import type { HindsightDatabase } from './db'
import type { EmbeddingStore } from './embedding'
import type {
	RetainOptions,
	RetainResult,
	MemoryUnit,
	Entity,
	FactType,
	LinkType,
	RerankFunction
} from './types'
import { sanitizeText } from './sanitize'
import { ftsInsert } from './fts'
import { consolidate } from './consolidation'
import type { BankProfile } from './reflect'
import {
	routeFact,
	applyReinforce,
	applyReconsolidate,
	logDecision,
	RECONSOLIDATE_THRESHOLD,
	type RoutingContext
} from './routing'
import {
	resolveEpisode,
	recordEpisodeEvent
} from './episodes'
import { generateFallbackGist } from './context-pack'
import type { RouteDecision, RetainRoute } from './types'
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
	parseISOToEpoch,
	parseEventDateToEpoch
} from './retain-extract'
import { resolveOrCreateEntity } from './retain-entities'
import {
	createTemporalLinksFromMemories,
	createSemanticLinks,
	updateCooccurrences,
	loadCooccurrences
} from './retain-links'

// Re-export public API
export { rowToMemoryUnit, rowToEntity } from './retain-db'
export { retainBatch } from './retain-batch'

// ── Main ───────────────────────────────────────────────────────────────────

export async function retain(
	hdb: HindsightDatabase,
	memoryVec: EmbeddingStore,
	entityVec: EmbeddingStore,
	modelVec: EmbeddingStore,
	adapter: AnyTextAdapter,
	bankId: string,
	content: string,
	options: RetainOptions = {},
	rerank?: RerankFunction,
	bankProfile?: BankProfile
): Promise<RetainResult> {
	const now = Date.now()
	const { schema } = hdb
	const eventDateMs = parseEventDateToEpoch(
		options.eventDate,
		now
	)
	const context = options.context
		? sanitizeText(options.context)
		: null
	const documentId = options.documentId ?? null
	const chunkId = documentId
		? `${bankId}_${documentId}_0`
		: null

	// Sanitize input content
	const cleanContent = sanitizeText(content)

	// ── Step 1: Get facts (LLM extraction or pre-provided) ──
	let extracted = await extractFactsFromContent(
		adapter,
		cleanContent,
		options,
		context,
		eventDateMs,
		0,
		1
	)

	if (extracted.length === 0) {
		return { memories: [], entities: [], links: [] }
	}
	const extractedOriginal = extracted.slice()

	// ── Step 1b: Route each fact (reinforce / reconsolidate / new_trace) ──

	const dedupThreshold = options.dedupThreshold ?? 0
	const decisions: RouteDecision[] = []
	const appliedMemoryIds: Array<{
		memoryId: string
		route: RetainRoute
		factIndex: number
		eventTime: number
	}> = []

	for (let i = 0; i < extracted.length; i++) {
		const fact = extracted[i]!
		if (dedupThreshold <= 0) {
			decisions.push({
				route: 'new_trace',
				candidateMemoryId: null,
				candidateScore: null,
				conflictDetected: false,
				conflictKeys: []
			})
			continue
		}
		const routingCtx: RoutingContext = {
			hdb,
			memoryVec,
			bankId,
			eventTime: eventDateMs + i,
			profile: options.profile ?? null,
			project: options.project ?? null
		}
		const decision = await routeFact(
			routingCtx,
			fact.content,
			fact.entities,
			{
				reinforceThreshold: dedupThreshold,
				reconsolidateThreshold: Math.min(
					RECONSOLIDATE_THRESHOLD,
					dedupThreshold
				)
			}
		)
		decisions.push(decision)
	}

	// Apply reinforce and reconsolidate actions immediately
	for (let i = 0; i < extracted.length; i++) {
		const decision = decisions[i]!
		const factEventTime = eventDateMs + i
		if (
			decision.route === 'reinforce' &&
			decision.candidateMemoryId
		) {
			runInTransaction(hdb, () => {
				applyReinforce(
					hdb,
					decision.candidateMemoryId!,
					now
				)
				logDecision(
					hdb,
					bankId,
					decision,
					decision.candidateMemoryId!,
					now
				)
			})
			appliedMemoryIds.push({
				memoryId: decision.candidateMemoryId,
				route: 'reinforce',
				factIndex: i,
				eventTime: factEventTime
			})
		} else if (
			decision.route === 'reconsolidate' &&
			decision.candidateMemoryId
		) {
			await applyReconsolidate(
				hdb,
				memoryVec,
				decision.candidateMemoryId,
				extracted[i]!.content,
				extracted[i]!.entities,
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
			appliedMemoryIds.push({
				memoryId: decision.candidateMemoryId,
				route: 'reconsolidate',
				factIndex: i,
				eventTime: factEventTime
			})
		}
	}

	// Filter to only new_trace facts for the insert pipeline
	const newTraceIndexRemap = new Map<number, number>()
	let newIdx = 0
	for (
		let oldIdx = 0;
		oldIdx < extracted.length;
		oldIdx++
	) {
		if (decisions[oldIdx]!.route === 'new_trace') {
			newTraceIndexRemap.set(oldIdx, newIdx++)
		}
	}

	extracted = extracted.filter(
		(_, i) => decisions[i]!.route === 'new_trace'
	)
	// Remap causal relation targetIndex values for new_trace facts
	for (const fact of extracted) {
		if (!fact.causalRelations) continue
		fact.causalRelations = fact.causalRelations
			.map(rel => ({
				...rel,
				targetIndex:
					newTraceIndexRemap.get(rel.targetIndex) ?? -1
			}))
			.filter(rel => rel.targetIndex >= 0)
	}

	if (
		extracted.length === 0 &&
		appliedMemoryIds.length === 0
	) {
		return { memories: [], entities: [], links: [] }
	}

	if (documentId && chunkId) {
		runInTransaction(hdb, () => {
			upsertDocuments(hdb, [
				{
					id: documentId,
					bankId,
					originalText: cleanContent,
					contentHash: buildContentHash(cleanContent),
					metadata: options.metadata
						? JSON.stringify(options.metadata)
						: null,
					retainParams: JSON.stringify({
						context: context ?? undefined,
						eventDate: eventDateMs
					}),
					tags: options.tags?.length
						? JSON.stringify(options.tags)
						: null,
					createdAt: now,
					updatedAt: now
				}
			])
			upsertChunks(hdb, [
				{
					id: chunkId,
					documentId,
					bankId,
					content: cleanContent,
					chunkIndex: 0,
					createdAt: now
				}
			])
		})
	}

	// ── Step 2: Resolve & upsert entities ──

	// Fetch all existing entities + co-occurrences for this bank (single query each)
	const existingEntities = hdb.db
		.select()
		.from(schema.entities)
		.where(eq(schema.entities.bankId, bankId))
		.all()

	const cooccurrences = loadCooccurrences(hdb, bankId)

	const entityMap = new Map<string, Entity>()
	// Track additional mentions per entity ID for batch mentionCount update
	const mentionDeltas = new Map<string, number>()

	for (const fact of extracted) {
		const nearbyNames = fact.entities.map(e => e.name)
		for (const ent of fact.entities) {
			await resolveOrCreateEntity(
				hdb,
				entityVec,
				schema,
				bankId,
				ent,
				nearbyNames,
				existingEntities,
				cooccurrences,
				entityMap,
				mentionDeltas,
				now
			)
		}
	}

	// Flush accumulated mention deltas to DB
	for (const [entityId, delta] of mentionDeltas) {
		const entity = existingEntities.find(
			e => e.id === entityId
		)
		if (!entity) continue
		hdb.db
			.update(schema.entities)
			.set({
				lastUpdated: now,
				mentionCount: entity.mentionCount + delta
			})
			.where(eq(schema.entities.id, entityId))
			.run()
	}

	// ── Step 3: Store memory units + FTS + embeddings ──

	const memories: MemoryUnit[] = []

	for (
		let factIndex = 0;
		factIndex < extracted.length;
		factIndex++
	) {
		const fact = extracted[factIndex]!
		const memoryId = ulid()
		const tags = [
			...(fact.tags ?? []),
			...(options.tags ?? [])
		]
		const memoryMetadata = options.metadata ?? null
		const sourceText = context
			? `${context}\n\n${cleanContent}`
			: cleanContent
		const mentionedAt = eventDateMs + factIndex
		const occurredStart = parseISOToEpoch(
			fact.occurredStart ?? fact.occurredStart
		)
		const occurredEnd = parseISOToEpoch(
			fact.occurredEnd ?? fact.occurredEnd
		)
		const eventDate = occurredStart ?? mentionedAt

		hdb.db
			.insert(schema.memoryUnits)
			.values({
				id: memoryId,
				bankId,
				documentId,
				chunkId,
				content: fact.content,
				factType: fact.factType,
				confidence: fact.confidence,
				eventDate,
				occurredStart,
				occurredEnd,
				mentionedAt,
				metadata: memoryMetadata
					? JSON.stringify(memoryMetadata)
					: null,
				tags: tags.length > 0 ? JSON.stringify(tags) : null,
				sourceText,
				accessCount: 0,
				lastAccessed: null,
				encodingStrength: 1.0,
				gist: generateFallbackGist(fact.content),
				scopeProfile: options.profile ?? null,
				scopeProject: options.project ?? null,
				scopeSession: options.session ?? null,
				createdAt: now,
				updatedAt: now
			})
			.run()

		// FTS5
		ftsInsert(hdb, memoryId, bankId, fact.content)

		// Embedding
		await memoryVec.upsert(memoryId, fact.content)

		// Memory ↔ Entity junction
		const linkedEntityIds: string[] = []
		for (const ent of fact.entities) {
			const key = `${ent.name.toLowerCase()}:${ent.entityType}`
			const entity = entityMap.get(key)
			if (!entity) continue
			hdb.db
				.insert(schema.memoryEntities)
				.values({ memoryId, entityId: entity.id })
				.run()
			linkedEntityIds.push(entity.id)
		}

		// Update co-occurrence table for all entity pairs linked to this memory
		updateCooccurrences(hdb, bankId, linkedEntityIds)

		memories.push({
			id: memoryId,
			bankId,
			content: fact.content,
			factType: fact.factType as FactType,
			confidence: fact.confidence,
			documentId,
			chunkId,
			eventDate,
			occurredStart,
			occurredEnd,
			mentionedAt,
			metadata: memoryMetadata,
			tags: tags.length > 0 ? tags : null,
			sourceText,
			consolidatedAt: null,
			proofCount: 0,
			sourceMemoryIds: null,
			history: null,
			createdAt: now,
			updatedAt: now
		})
	}

	// ── Step 4: Create entity-based links between co-occurring memories ──

	const links: RetainResult['links'] = []

	{
		// Build inverted index: entity name → memory indices
		const entityToMemories = new Map<string, number[]>()
		const entityCountPerMemory: number[] = []
		for (let i = 0; i < memories.length; i++) {
			const names = extracted[i]!.entities.map(e =>
				e.name.toLowerCase()
			)
			entityCountPerMemory[i] = new Set(names).size
			for (const name of new Set(names)) {
				let bucket = entityToMemories.get(name)
				if (!bucket) {
					bucket = []
					entityToMemories.set(name, bucket)
				}
				bucket.push(i)
			}
		}

		// Accumulate shared entity counts per pair via bucket join
		const pairShared = new Map<string, number>()
		for (const bucket of entityToMemories.values()) {
			if (bucket.length < 2) continue
			for (let a = 0; a < bucket.length; a++) {
				for (let b = a + 1; b < bucket.length; b++) {
					const key = `${bucket[a]}:${bucket[b]}`
					pairShared.set(
						key,
						(pairShared.get(key) ?? 0) + 1
					)
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
				.insert(schema.memoryLinks)
				.values({
					id: ulid(),
					bankId,
					sourceId: memories[i]!.id,
					targetId: memories[j]!.id,
					linkType: 'entity',
					weight,
					createdAt: now
				})
				.onConflictDoNothing()
				.run()

			links.push({
				sourceId: memories[i]!.id,
				targetId: memories[j]!.id,
				linkType: 'entity' as LinkType
			})
		}
	}

	// ── Step 5: Create causal links ──

	for (let i = 0; i < extracted.length; i++) {
		const fact = extracted[i]!
		for (const rel of fact.causalRelations ?? []) {
			if (rel.targetIndex < 0 || rel.targetIndex >= i)
				continue // only backward refs
			const sourceId = memories[i]!.id
			const targetId = memories[rel.targetIndex]!.id
			if (sourceId === targetId) continue

			const linkType = rel.relationType ?? 'caused_by'

			hdb.db
				.insert(schema.memoryLinks)
				.values({
					id: ulid(),
					bankId,
					sourceId,
					targetId,
					linkType,
					weight: rel.strength,
					createdAt: now
				})
				.onConflictDoNothing()
				.run()

			links.push({ sourceId, targetId, linkType })
		}
	}

	// ── Step 6: Create temporal links ──

	createTemporalLinksFromMemories(
		hdb,
		bankId,
		memories,
		now,
		links
	)

	// ── Step 7: Create semantic links ──

	const semanticLinks = await createSemanticLinks(
		hdb,
		memoryVec,
		bankId,
		memories.map(m => m.id)
	)
	links.push(...semanticLinks)

	// ── Step 8: Auto-consolidate (creates observations + refreshes mental models) ──

	const shouldConsolidate = options.consolidate !== false

	if (shouldConsolidate) {
		// Fire-and-forget — don't block retain
		consolidate(
			hdb,
			memoryVec,
			modelVec,
			adapter,
			bankId,
			{},
			rerank,
			bankProfile
		).catch(
			() => {} // swallow errors — consolidation is best-effort
		)
	}

	// ── Step 9: Log new_trace decisions ──

	const originalIndexByNewTraceIndex = new Map<
		number,
		number
	>()
	for (const [
		originalIndex,
		newTraceIndex
	] of newTraceIndexRemap.entries()) {
		originalIndexByNewTraceIndex.set(
			newTraceIndex,
			originalIndex
		)
	}

	for (let i = 0; i < memories.length; i++) {
		const originalIdx = originalIndexByNewTraceIndex.get(i)
		if (originalIdx !== undefined) {
			const decision = decisions[originalIdx]!
			logDecision(
				hdb,
				bankId,
				decision,
				memories[i]!.id,
				now
			)
		}
	}

	// ── Step 10: Load reinforced/reconsolidated memories into result ──

	const allMemories: MemoryUnit[] = []
	for (const { memoryId } of appliedMemoryIds) {
		const row = hdb.db
			.select()
			.from(hdb.schema.memoryUnits)
			.where(eq(hdb.schema.memoryUnits.id, memoryId))
			.get()
		if (row) {
			allMemories.push(rowToMemoryUnit(row))
		}
	}
	allMemories.push(...memories)

	// ── Step 11: Episode tracking ──

	const profile = options.profile ?? null
	const project = options.project ?? null
	const session = options.session ?? null

	for (const applied of appliedMemoryIds) {
		const fact = extractedOriginal[applied.factIndex]
		const episodeId = resolveEpisode(
			hdb,
			bankId,
			applied.eventTime,
			profile,
			project,
			session,
			fact?.content ?? cleanContent
		)
		recordEpisodeEvent(
			hdb,
			episodeId,
			bankId,
			applied.memoryId,
			applied.route,
			applied.eventTime,
			profile,
			project,
			session
		)
	}

	for (let i = 0; i < memories.length; i++) {
		const originalIdx = originalIndexByNewTraceIndex.get(i)
		const eventTime =
			originalIdx != null ? eventDateMs + originalIdx : now
		const episodeId = resolveEpisode(
			hdb,
			bankId,
			eventTime,
			profile,
			project,
			session,
			memories[i]!.content
		)
		recordEpisodeEvent(
			hdb,
			episodeId,
			bankId,
			memories[i]!.id,
			'new_trace',
			eventTime,
			profile,
			project,
			session
		)
	}

	// ── Step 8b: Fire-and-forget LLM gist generation ──
	// Upgrade the deterministic fallback gist with LLM-generated gists asynchronously.
	scheduleGistUpgrades(adapter, hdb, schema, memories)

	return {
		memories: allMemories,
		entities: Array.from(entityMap.values()),
		links
	}
}
