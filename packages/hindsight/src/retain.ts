import { chat, streamToText } from '@ellie/ai'
import { ulid } from '@ellie/utils'
import { createHash } from 'crypto'
import { and, eq } from 'drizzle-orm'
import type { AnyTextAdapter } from '@tanstack/ai'
import { RecursiveChunker } from '@chonkiejs/core'
import type { HindsightDatabase } from './db'
import type { EmbeddingStore } from './embedding'
import type {
	RetainOptions,
	RetainBatchOptions,
	RetainResult,
	RetainBatchResult,
	RetainBatchItem,
	MemoryUnit,
	Entity,
	FactType,
	EntityType,
	LinkType,
	RerankFunction,
	TranscriptTurn
} from './types'
import {
	getExtractionPrompt,
	EXTRACT_FACTS_USER
} from './prompts'
import { sanitizeText, parseLLMJson } from './sanitize'
import { resolveEntity } from './entity-resolver'
import { consolidate } from './consolidation'
import type { BankProfile } from './reflect'
import {
	TEMPORAL_LINK_WINDOW_HOURS,
	computeTemporalLinks,
	computeTemporalQueryBounds,
	computeTemporalWeight
} from './retain-link-utils'
import {
	routeFact,
	routeFactByVector,
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
import type { RouteDecision, RetainRoute } from './types'
import { generateGistWithLLM } from './gist'
import { generateFallbackGist } from './context-pack'

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeJsonParse<T>(
	value: string | null,
	fallback: T
): T {
	if (!value) return fallback
	try {
		return JSON.parse(value) as T
	} catch {
		return fallback
	}
}

/** Max concurrent LLM gist generation requests. */
const GIST_CONCURRENCY = 3

/**
 * Fire-and-forget LLM gist upgrade with bounded concurrency.
 * Runs at most GIST_CONCURRENCY requests in parallel and logs per-item errors
 * without aborting the queue.
 */
function scheduleGistUpgrades(
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

// ── Extraction response normalization (Python + TS parity) ────────────────

// Python parity: only "caused_by" is a valid causal relation type.
// The extraction prompt instructs the LLM to use "caused_by" exclusively.
const CAUSAL_LINK_TYPES = new Set(['caused_by'] as const)

type CausalLinkType = 'caused_by'

interface ExtractedEntity {
	name: string
	entityType: EntityType
}

interface ExtractedCausalRelation {
	targetIndex: number
	relationType: CausalLinkType
	strength: number
}

interface ExtractedFact {
	content: string
	factType: FactType
	confidence: number
	eventDate: string | null
	occurredStart: string | null
	occurredEnd: string | null
	mentionedAt: string | null
	entities: ExtractedEntity[]
	tags: string[]
	causalRelations: ExtractedCausalRelation[]
}

const CHARS_PER_BATCH = 600_000

interface PreparedExtractedFact {
	fact: ExtractedFact
	originalIndex: number
	groupIndex: number
	sourceText: string
	context: string | null
	eventDateMs: number
	documentId: string
	chunkId: string
	metadata: Record<string, unknown> | null
	tags: string[]
	profile: string | null
	project: string | null
	session: string | null
}

interface NormalizedBatchItem {
	content: string
	context: string | null
	eventDateMs: number
	documentId: string
	metadata: Record<string, unknown> | null
	tags: string[]
	profile: string | null
	project: string | null
	session: string | null
}

interface ExpandedBatchContent {
	originalIndex: number
	content: string
	chunkIndex: number
	chunkCount: number
	chunkId: string
	context: string | null
	eventDateMs: number
	documentId: string
	metadata: Record<string, unknown> | null
	tags: string[]
	profile: string | null
	project: string | null
	session: string | null
}

interface EntityPlan {
	entityMap: Map<string, Entity>
	entityById: Map<string, Entity>
	existingMentionDeltas: Map<string, number>
	newEntities: Array<{
		id: string
		bankId: string
		name: string
		entityType: EntityType
		mentionCount: number
		firstSeen: number
		lastUpdated: number
	}>
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseISOToEpoch(
	iso: string | null | undefined
): number | null {
	if (!iso) return null
	const ms = new Date(iso).getTime()
	return Number.isNaN(ms) ? null : ms
}

function mapFactType(value: unknown): FactType {
	if (value === 'assistant') return 'experience'
	if (
		value === 'world' ||
		value === 'experience' ||
		value === 'opinion' ||
		value === 'observation'
	) {
		return value
	}
	return 'world'
}

function readString(value: unknown): string | null {
	return typeof value === 'string' &&
		value.trim().length > 0
		? sanitizeText(value).trim()
		: null
}

function readIsoDate(value: unknown): string | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return new Date(value).toISOString()
	}
	const text = readString(value)
	if (!text) return null
	const ms = new Date(text).getTime()
	if (Number.isNaN(ms)) return null
	return new Date(ms).toISOString()
}

function inferTemporalDate(
	content: string,
	eventDateMs: number
): string | null {
	const lowered = content.toLowerCase()
	const patterns: Array<[RegExp, number]> = [
		[/\blast night\b/, -1],
		[/\byesterday\b/, -1],
		[/\btoday\b/, 0],
		[/\bthis morning\b/, 0],
		[/\bthis afternoon\b/, 0],
		[/\bthis evening\b/, 0],
		[/\btonight\b/, 0],
		[/\btomorrow\b/, 1],
		[/\blast week\b/, -7],
		[/\bthis week\b/, 0],
		[/\bnext week\b/, 7],
		[/\blast month\b/, -30],
		[/\bthis month\b/, 0],
		[/\bnext month\b/, 30]
	]

	for (const [pattern, offset] of patterns) {
		if (!pattern.test(lowered)) continue
		const date = new Date(
			eventDateMs + offset * 24 * 60 * 60 * 1000
		)
		date.setUTCHours(0, 0, 0, 0)
		return date.toISOString()
	}
	return null
}

function parseEntity(
	entry: unknown
): ExtractedEntity | null {
	if (typeof entry === 'string') {
		const name = readString(entry)
		if (!name) return null
		return { name, entityType: 'concept' }
	}
	if (!entry || typeof entry !== 'object') return null
	const record = entry as Record<string, unknown>
	const name =
		readString(record.name) ?? readString(record.text)
	if (!name) return null
	const entityType = (record.entityType ??
		record.entity_type ??
		'concept') as EntityType
	if (
		entityType !== 'person' &&
		entityType !== 'organization' &&
		entityType !== 'place' &&
		entityType !== 'concept' &&
		entityType !== 'other'
	) {
		return { name, entityType: 'concept' }
	}
	return { name, entityType }
}

function parseCausalRelation(
	entry: unknown
): ExtractedCausalRelation | null {
	if (!entry || typeof entry !== 'object') return null
	const record = entry as Record<string, unknown>
	const rawTarget =
		record.targetIndex ?? record.target_index
	const targetIndex =
		typeof rawTarget === 'number' &&
		Number.isFinite(rawTarget)
			? Math.floor(rawTarget)
			: null
	if (targetIndex == null || targetIndex < 0) return null

	const rawType = String(
		record.relationType ??
			record.relation_type ??
			'caused_by'
	) as CausalLinkType
	const relationType = CAUSAL_LINK_TYPES.has(rawType)
		? rawType
		: 'caused_by'
	const rawStrength = record.strength
	const strength =
		typeof rawStrength === 'number' &&
		Number.isFinite(rawStrength)
			? Math.max(0, Math.min(1, rawStrength))
			: 1

	return { targetIndex, relationType, strength }
}

function normalizeExtractedFacts(
	parsed: unknown,
	eventDateMs: number
): ExtractedFact[] {
	if (!parsed || typeof parsed !== 'object') return []
	const facts = (parsed as { facts?: unknown }).facts
	if (!Array.isArray(facts)) return []

	const normalized: ExtractedFact[] = []
	for (const entry of facts) {
		if (!entry || typeof entry !== 'object') continue
		const fact = entry as Record<string, unknown>

		const what =
			readString(fact.what) ?? readString(fact.factual_core)
		const when = readString(fact.when)
		const who = readString(fact.who)
		const why = readString(fact.why)
		const content =
			readString(fact.content) ??
			[
				what,
				when ? `When: ${when}` : null,
				who ? `Involving: ${who}` : null,
				why
			]
				.filter((part): part is string => Boolean(part))
				.join(' | ')

		if (!content) continue

		const factType = mapFactType(
			fact.factType ?? fact.fact_type
		)
		const factKind = String(
			fact.factKind ?? fact.fact_kind ?? 'conversation'
		).toLowerCase()
		let occurredStart =
			readIsoDate(fact.occurredStart) ??
			readIsoDate(fact.occurred_start) ??
			readIsoDate(fact.occurredStart) ??
			readIsoDate(fact.occurred_start)
		let occurredEnd =
			readIsoDate(fact.occurredEnd) ??
			readIsoDate(fact.occurred_end) ??
			readIsoDate(fact.occurredEnd) ??
			readIsoDate(fact.occurred_end)
		let mentionedAt =
			readIsoDate(fact.mentionedAt) ??
			readIsoDate(fact.mentioned_at)

		if (!occurredStart && factKind === 'event') {
			occurredStart = inferTemporalDate(
				content,
				eventDateMs
			)
		}
		if (
			!occurredEnd &&
			occurredStart &&
			factKind === 'event'
		) {
			occurredEnd = occurredStart
		}
		if (!mentionedAt) {
			mentionedAt = new Date(eventDateMs).toISOString()
		}

		const confidence =
			typeof fact.confidence === 'number' &&
			Number.isFinite(fact.confidence)
				? fact.confidence
				: 1
		const tags = Array.isArray(fact.tags)
			? fact.tags
					.map(tag => readString(tag))
					.filter((tag): tag is string => Boolean(tag))
			: []
		const entities = Array.isArray(fact.entities)
			? fact.entities
					.map(entity => parseEntity(entity))
					.filter((entity): entity is ExtractedEntity =>
						Boolean(entity)
					)
			: []
		const causalSource = Array.isArray(fact.causalRelations)
			? fact.causalRelations
			: Array.isArray(fact.causal_relations)
				? fact.causal_relations
				: []
		const causalRelations = causalSource
			.map(relation => parseCausalRelation(relation))
			.filter(
				(relation): relation is ExtractedCausalRelation =>
					Boolean(relation)
			)

		normalized.push({
			content,
			factType,
			confidence,
			eventDate: occurredStart ?? mentionedAt,
			occurredStart,
			occurredEnd,
			mentionedAt,
			entities,
			tags,
			causalRelations
		})
	}
	return normalized
}

function parseEventDateToEpoch(
	input: number | Date | string | null | undefined,
	fallback: number
): number {
	if (input == null) return fallback
	if (typeof input === 'number')
		return Number.isFinite(input) ? input : fallback
	if (input instanceof Date) {
		const ms = input.getTime()
		return Number.isFinite(ms) ? ms : fallback
	}
	const ms = new Date(input).getTime()
	return Number.isFinite(ms) ? ms : fallback
}

function mergeMetadata(
	base?: Record<string, unknown> | null,
	extra?: Record<string, unknown> | null
): Record<string, unknown> | null {
	if (!base && !extra) return null
	return {
		...base,
		...extra
	}
}

function isTranscriptTurnArray(
	value: unknown
): value is TranscriptTurn[] {
	return (
		Array.isArray(value) &&
		value.every(
			turn =>
				turn &&
				typeof turn === 'object' &&
				typeof (turn as { role?: unknown }).role ===
					'string' &&
				typeof (turn as { content?: unknown }).content ===
					'string'
		)
	)
}

function normalizeContentInput(
	content: string | TranscriptTurn[]
): string {
	if (typeof content === 'string')
		return sanitizeText(content)
	const normalizedTurns = content.map(turn => ({
		role: turn.role,
		content: sanitizeText(turn.content)
	}))
	return JSON.stringify(normalizedTurns)
}

function normalizeBatchInputs(
	bankId: string,
	contents: string[] | RetainBatchItem[],
	options: RetainBatchOptions
): NormalizedBatchItem[] {
	const now = Date.now()
	const normalized: NormalizedBatchItem[] = []

	for (let i = 0; i < contents.length; i++) {
		const value = contents[i]
		const item =
			typeof value === 'string' ? { content: value } : value
		const sanitizedContent = normalizeContentInput(
			item.content
		)
		const documentId =
			item.documentId ?? `${bankId}-${ulid()}`
		normalized.push({
			content: sanitizedContent,
			context: item.context ?? options.context ?? null,
			eventDateMs: parseEventDateToEpoch(
				item.eventDate ?? options.eventDate,
				now
			),
			documentId,
			metadata: mergeMetadata(
				options.metadata ?? null,
				item.metadata ?? null
			),
			tags: [
				...new Set([
					...(options.tags ?? []),
					...(item.tags ?? [])
				])
			],
			profile: item.profile ?? options.profile ?? null,
			project: item.project ?? options.project ?? null,
			session: item.session ?? options.session ?? null
		})
	}

	return normalized
}

async function extractFactsFromContent(
	adapter: AnyTextAdapter,
	content: string,
	options: RetainOptions | RetainBatchOptions,
	context?: string | null,
	eventDateMs = Date.now(),
	chunkIndex = 0,
	totalChunks = 1
): Promise<ExtractedFact[]> {
	if ('facts' in options && options.facts) {
		return options.facts.map(f => ({
			content: sanitizeText(f.content),
			factType: (f.factType ??
				'world') as ExtractedFact['factType'],
			confidence: f.confidence ?? 1.0,
			eventDate: null,
			occurredStart:
				f.occurredStart != null
					? new Date(f.occurredStart).toISOString()
					: null,
			occurredEnd:
				f.occurredEnd != null
					? new Date(f.occurredEnd).toISOString()
					: null,
			mentionedAt: null,
			entities: (f.entities ?? []).map(name => ({
				name,
				entityType: 'concept' as const
			})),
			tags: f.tags ?? [],
			causalRelations: Array.isArray(f.causalRelations)
				? f.causalRelations
						.map(rel => parseCausalRelation(rel))
						.filter((rel): rel is ExtractedCausalRelation =>
							Boolean(rel)
						)
				: []
		}))
	}

	const extractionInput = content

	try {
		const systemPrompt = getExtractionPrompt(
			options.mode ?? 'concise',
			options.customGuidelines
		)

		const text = await streamToText(
			chat({
				adapter,
				messages: [
					{
						role: 'user',
						content: EXTRACT_FACTS_USER({
							text: extractionInput,
							chunkIndex,
							totalChunks,
							eventDateMs,
							context
						})
					}
				],
				systemPrompts: [systemPrompt],
				modelOptions: {
					response_format: { type: 'json_object' }
				}
			})
		)

		const parsed = parseLLMJson(text, { facts: [] })
		const extracted = normalizeExtractedFacts(
			parsed,
			eventDateMs
		)
		for (const fact of extracted) {
			fact.content = sanitizeText(fact.content)
		}
		return extracted
	} catch {
		// Graceful degradation: LLM extraction failed, return empty result
		return []
	}
}

function runInTransaction(
	hdb: HindsightDatabase,
	fn: () => void
): void {
	hdb.sqlite.run('BEGIN')
	try {
		fn()
		hdb.sqlite.run('COMMIT')
	} catch (error) {
		hdb.sqlite.run('ROLLBACK')
		throw error
	}
}

function chunkTranscriptTurns(
	turns: TranscriptTurn[]
): string[] {
	const chunks: string[] = []
	let current: TranscriptTurn[] = []
	let currentChars = 2
	for (const turn of turns) {
		const turnText = JSON.stringify(turn)
		const turnChars = turnText.length + 1
		if (
			current.length > 0 &&
			currentChars + turnChars > CHARS_PER_BATCH
		) {
			chunks.push(JSON.stringify(current))
			current = []
			currentChars = 2
		}
		current.push(turn)
		currentChars += turnChars
	}
	if (current.length > 0)
		chunks.push(JSON.stringify(current))
	return chunks
}

async function chunkWithChonkie(
	content: string
): Promise<string[]> {
	if (content.length <= CHARS_PER_BATCH) return [content]

	const parsed = parseLLMJson<unknown>(content, null)
	if (isTranscriptTurnArray(parsed)) {
		const transcriptChunks = chunkTranscriptTurns(parsed)
		if (transcriptChunks.length > 0) return transcriptChunks
	}

	const chunker = await RecursiveChunker.create({
		chunkSize: CHARS_PER_BATCH,
		tokenizer: 'character',
		minCharactersPerChunk: 1
	})
	const chunks = await chunker.chunk(content)
	const texts = chunks
		.map(chunk => sanitizeText(chunk.text).trim())
		.filter(chunkText => chunkText.length > 0)
	return texts.length > 0 ? texts : [content]
}

async function explodeBatchContents(
	bankId: string,
	contents: NormalizedBatchItem[]
): Promise<ExpandedBatchContent[]> {
	const chunked = await Promise.all(
		contents.map(async (item, originalIndex) => {
			const chunks = await chunkWithChonkie(item.content)
			return chunks.map((chunk, chunkIndex) => {
				const chunkId = `${bankId}_${item.documentId}_${chunkIndex}`
				return {
					originalIndex,
					content: chunk,
					chunkIndex,
					chunkCount: chunks.length,
					chunkId,
					context: item.context,
					eventDateMs: item.eventDateMs,
					documentId: item.documentId,
					metadata: item.metadata,
					tags: item.tags,
					profile: item.profile,
					project: item.project,
					session: item.session
				}
			})
		})
	)
	return chunked.flat()
}

function splitByCharacterBudget<
	T extends { content: string }
>(items: T[], maxChars: number): T[][] {
	if (items.length === 0) return []
	const batches: T[][] = []
	let currentBatch: T[] = []
	let currentChars = 0

	for (const item of items) {
		const itemChars = item.content.length
		if (
			currentBatch.length > 0 &&
			currentChars + itemChars > maxChars
		) {
			batches.push(currentBatch)
			currentBatch = [item]
			currentChars = itemChars
			continue
		}

		currentBatch.push(item)
		currentChars += itemChars
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch)
	}

	return batches
}

function buildContentHash(content: string): string {
	return createHash('sha256').update(content).digest('hex')
}

function upsertDocuments(
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

function upsertChunks(
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

function planEntities(
	hdb: HindsightDatabase,
	bankId: string,
	extracted: PreparedExtractedFact[],
	now: number
): EntityPlan {
	const existingEntities = hdb.db
		.select()
		.from(hdb.schema.entities)
		.where(eq(hdb.schema.entities.bankId, bankId))
		.all()
	const cooccurrences = loadCooccurrences(hdb, bankId)

	const entityMap = new Map<string, Entity>()
	const entityById = new Map<string, Entity>()
	const existingMentionDeltas = new Map<string, number>()
	const newEntities: EntityPlan['newEntities'] = []
	const newEntityById = new Map<
		string,
		EntityPlan['newEntities'][number]
	>()

	for (const item of extracted) {
		const nearbyNames = item.fact.entities.map(
			entity => entity.name
		)
		for (const ent of item.fact.entities) {
			const key = `${ent.name.toLowerCase()}:${ent.entityType}`
			const seen = entityMap.get(key)
			if (seen) {
				const pending = newEntityById.get(seen.id)
				if (pending) {
					pending.mentionCount += 1
					continue
				}
				existingMentionDeltas.set(
					seen.id,
					(existingMentionDeltas.get(seen.id) ?? 0) + 1
				)
				continue
			}

			const resolved = resolveEntity(
				ent.name,
				ent.entityType,
				existingEntities,
				cooccurrences,
				nearbyNames.filter(name => name !== ent.name),
				now
			)
			const exactMatch = existingEntities.find(
				row =>
					row.name.toLowerCase() ===
						ent.name.toLowerCase() &&
					row.entityType === ent.entityType
			)

			if (resolved || exactMatch) {
				const row =
					(resolved
						? existingEntities.find(
								entity => entity.id === resolved.entityId
							)
						: exactMatch) ?? null
				if (!row) continue

				const entity = rowToEntity({
					...row,
					lastUpdated: now
				})
				entityMap.set(key, entity)
				entityById.set(entity.id, entity)
				existingMentionDeltas.set(
					entity.id,
					(existingMentionDeltas.get(entity.id) ?? 0) + 1
				)
				continue
			}

			const entityId = ulid()
			const pendingEntity: EntityPlan['newEntities'][number] =
				{
					id: entityId,
					bankId,
					name: ent.name,
					entityType: ent.entityType as EntityType,
					mentionCount: 1,
					firstSeen: now,
					lastUpdated: now
				}
			newEntities.push(pendingEntity)
			newEntityById.set(entityId, pendingEntity)

			const entity: Entity = {
				id: entityId,
				bankId,
				name: ent.name,
				entityType: ent.entityType as EntityType,
				description: null,
				metadata: null,
				firstSeen: now,
				lastUpdated: now
			}
			entityMap.set(key, entity)
			entityById.set(entity.id, entity)
			existingEntities.push({
				id: entityId,
				bankId,
				name: ent.name,
				entityType: ent.entityType,
				description: null,
				metadata: null,
				mentionCount: pendingEntity.mentionCount,
				firstSeen: now,
				lastUpdated: now
			})
		}
	}

	return {
		entityMap,
		entityById,
		existingMentionDeltas,
		newEntities
	}
}

function rowToMemoryUnit(
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
			import('./types').ObservationHistoryEntry[] | null
		>(row.history, null),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	}
}

function rowToEntity(
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

// ── Entity resolution (single entity) ────────────────────────────────────────

async function resolveOrCreateEntity(
	hdb: HindsightDatabase,
	entityVec: EmbeddingStore,
	schema: HindsightDatabase['schema'],
	bankId: string,
	ent: ExtractedEntity,
	nearbyNames: string[],
	existingEntities: Array<
		typeof import('./schema').entities.$inferSelect
	>,
	cooccurrences: Map<string, Set<string>>,
	entityMap: Map<string, Entity>,
	mentionDeltas: Map<string, number>,
	now: number
): Promise<void> {
	const key = `${ent.name.toLowerCase()}:${ent.entityType}`

	if (entityMap.has(key)) {
		const entity = entityMap.get(key)!
		mentionDeltas.set(
			entity.id,
			(mentionDeltas.get(entity.id) ?? 0) + 1
		)
		return
	}

	const resolved = resolveEntity(
		ent.name,
		ent.entityType,
		existingEntities,
		cooccurrences,
		nearbyNames.filter(n => n !== ent.name),
		now
	)

	if (resolved) {
		const matchedEntity = existingEntities.find(
			e => e.id === resolved.entityId
		)!
		mentionDeltas.set(
			matchedEntity.id,
			(mentionDeltas.get(matchedEntity.id) ?? 0) + 1
		)
		entityMap.set(
			key,
			rowToEntity({ ...matchedEntity, lastUpdated: now })
		)
		return
	}

	const exactMatch = existingEntities.find(
		e =>
			e.name.toLowerCase() === ent.name.toLowerCase() &&
			e.entityType === ent.entityType
	)

	if (exactMatch) {
		mentionDeltas.set(
			exactMatch.id,
			(mentionDeltas.get(exactMatch.id) ?? 0) + 1
		)
		entityMap.set(
			key,
			rowToEntity({ ...exactMatch, lastUpdated: now })
		)
		return
	}

	const entityId = ulid()
	hdb.db
		.insert(schema.entities)
		.values({
			id: entityId,
			bankId,
			name: ent.name,
			entityType: ent.entityType,
			mentionCount: 1,
			firstSeen: now,
			lastUpdated: now
		})
		.run()

	await entityVec.upsert(entityId, ent.name)

	const newEntity: Entity = {
		id: entityId,
		bankId,
		name: ent.name,
		entityType: ent.entityType as EntityType,
		description: null,
		metadata: null,
		firstSeen: now,
		lastUpdated: now
	}
	entityMap.set(key, newEntity)

	existingEntities.push({
		id: entityId,
		bankId,
		name: ent.name,
		entityType: ent.entityType,
		description: null,
		metadata: null,
		mentionCount: 1,
		firstSeen: now,
		lastUpdated: now
	})
}

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
		hdb.sqlite.run(
			'INSERT INTO hs_memory_fts (id, bank_id, content) VALUES (?, ?, ?)',
			[memoryId, bankId, fact.content]
		)

		// Embedding
		await memoryVec.upsert(memoryId, fact.content)

		// Memory ↔ Entity junction
		const linkedEntityIds: string[] = []
		for (const ent of fact.entities) {
			const key = `${ent.name.toLowerCase()}:${ent.entityType}`
			const entity = entityMap.get(key)
			if (entity) {
				hdb.db
					.insert(schema.memoryEntities)
					.values({ memoryId, entityId: entity.id })
					.run()
				linkedEntityIds.push(entity.id)
			}
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

	for (let i = 0; i < memories.length; i++) {
		for (let j = i + 1; j < memories.length; j++) {
			const entitiesI = new Set(
				extracted[i]!.entities.map(e =>
					e.name.toLowerCase()
				)
			)
			const entitiesJ = new Set(
				extracted[j]!.entities.map(e =>
					e.name.toLowerCase()
				)
			)
			const shared = [...entitiesI].filter(e =>
				entitiesJ.has(e)
			)
			if (shared.length === 0) continue

			const linkId = ulid()
			const weight =
				shared.length /
				Math.max(entitiesI.size, entitiesJ.size, 1)

			hdb.db
				.insert(schema.memoryLinks)
				.values({
					id: linkId,
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

// ── Batch new-trace processing ──────────────────────────────────────────────

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

		const linkedEntityIds: string[] = []
		const linkedEntityNames = new Set<string>()
		for (const ent of item.fact.entities) {
			const key = `${ent.name.toLowerCase()}:${ent.entityType}`
			const entity = entityPlan.entityMap.get(key)
			if (!entity) continue
			linkedEntityIds.push(entity.id)
			linkedEntityNames.add(ent.name.toLowerCase())
			entityIdsByResult[item.originalIndex]!.add(entity.id)
		}

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
			hdb.sqlite.run(
				'INSERT INTO hs_memory_fts (id, bank_id, content) VALUES (?, ?, ?)',
				[row.id, bankId, row.content]
			)
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

export async function retainBatch(
	hdb: HindsightDatabase,
	memoryVec: EmbeddingStore,
	entityVec: EmbeddingStore,
	modelVec: EmbeddingStore,
	adapter: AnyTextAdapter,
	bankId: string,
	contents: string[] | RetainBatchItem[],
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
		const batchAppliedMemoryIds: Array<{
			memoryId: string
			route: RetainRoute
			originalIndex: number
			flatIndex: number
			eventTime: number
			profile: string | null
			project: string | null
			session: string | null
			sourceText: string
		}> = []

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
				batchAppliedMemoryIds.push({
					memoryId: decision.candidateMemoryId,
					route: 'reinforce',
					originalIndex: item.originalIndex,
					flatIndex: i,
					eventTime,
					profile: item.profile,
					project: item.project,
					session: item.session,
					sourceText: item.fact.content
				})
			} else if (
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
				batchAppliedMemoryIds.push({
					memoryId: decision.candidateMemoryId,
					route: 'reconsolidate',
					originalIndex: item.originalIndex,
					flatIndex: i,
					eventTime,
					profile: item.profile,
					project: item.project,
					session: item.session,
					sourceText: item.fact.content
				})
			}
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

// ── Semantic Links ─────────────────────────────────────────────────────────

const SEMANTIC_LINK_THRESHOLD = 0.7
const SEMANTIC_LINK_TOP_K = 5

function createEntityLinksFromMemories(
	hdb: HindsightDatabase,
	bankId: string,
	memoryIds: string[],
	memoryEntityNames: Map<string, Set<string>>,
	createdAt: number,
	output: RetainResult['links']
): void {
	for (let i = 0; i < memoryIds.length; i++) {
		const sourceId = memoryIds[i]!
		const sourceEntities =
			memoryEntityNames.get(sourceId) ?? new Set<string>()
		for (let j = i + 1; j < memoryIds.length; j++) {
			const targetId = memoryIds[j]!
			const targetEntities =
				memoryEntityNames.get(targetId) ?? new Set<string>()
			const shared = [...sourceEntities].filter(name =>
				targetEntities.has(name)
			)
			if (shared.length === 0) continue

			const weight =
				shared.length /
				Math.max(
					sourceEntities.size,
					targetEntities.size,
					1
				)

			hdb.db
				.insert(hdb.schema.memoryLinks)
				.values({
					id: ulid(),
					bankId,
					sourceId,
					targetId,
					linkType: 'entity',
					weight,
					createdAt
				})
				.onConflictDoNothing()
				.run()

			output.push({
				sourceId,
				targetId,
				linkType: 'entity'
			})
		}
	}
}

function createTemporalLinksFromMemories(
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

		for (let j = i + 1; j < newMemories.length; j++) {
			const target = newMemories[j]!
			const targetAnchor = getTemporalAnchor(
				target.eventDate,
				target.occurredStart,
				target.occurredEnd,
				target.mentionedAt,
				target.createdAt
			)
			if (targetAnchor == null) continue

			const distanceMs = Math.abs(
				sourceAnchor - targetAnchor
			)
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
}

function getTemporalAnchor(
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

function insertTemporalLinkIfMissing(
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

function insertCausalRelations(
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

function createCausalLinksFromGroups(
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
}

function createSemanticLinksFromVectors(
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

		for (const hit of hits) {
			if (hit.id === memory.id || newMemoryIds.has(hit.id))
				continue
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
					sourceId: memory.id,
					targetId: hit.id,
					linkType: 'semantic',
					weight: similarity,
					createdAt
				})
				.onConflictDoNothing()
				.run()

			output.push({
				sourceId: memory.id,
				targetId: hit.id,
				linkType: 'semantic'
			})
		}
	}
}

function addUniqueLink(
	result: RetainResult,
	linkKeys: Set<string>,
	link: RetainResult['links'][number]
): void {
	const key = `${link.sourceId}:${link.targetId}:${link.linkType}`
	if (linkKeys.has(key)) return
	linkKeys.add(key)
	result.links.push(link)
}

async function createSemanticLinks(
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

		for (const hit of hits) {
			// Skip self and other new memories (entity links already cover within-batch)
			if (hit.id === memoryId || newIdSet.has(hit.id))
				continue

			const similarity = 1 - hit.distance
			if (similarity < SEMANTIC_LINK_THRESHOLD) continue

			// Verify same bank
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

	return links
}

// ── Co-occurrence Helpers ──────────────────────────────────────────────────

/**
 * Load all co-occurrence data for a bank into a Map<entityId, Set<entityId>>.
 */
function loadCooccurrences(
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
function updateCooccurrences(
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

export { rowToMemoryUnit, rowToEntity }
