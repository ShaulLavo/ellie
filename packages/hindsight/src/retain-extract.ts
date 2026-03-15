import { chat, streamToText } from './traced-chat'
import { ulid } from 'fast-ulid'
import type { AnyTextAdapter } from '@tanstack/ai'
import { RecursiveChunker } from '@chonkiejs/core'
import type {
	RetainOptions,
	RetainBatchOptions,
	RetainBatchItem,
	FactType,
	EntityType,
	TranscriptTurn
} from './types'
import {
	getExtractionPrompt,
	EXTRACT_FACTS_USER
} from './prompts'
import { sanitizeText, parseLLMJson } from './sanitize'

// Python parity: only "caused_by" is a valid causal relation type.
// The extraction prompt instructs the LLM to use "caused_by" exclusively.
const CAUSAL_LINK_TYPES = new Set(['caused_by'] as const)

export type CausalLinkType = 'caused_by'

export interface ExtractedEntity {
	name: string
	entityType: EntityType
}

export interface ExtractedCausalRelation {
	targetIndex: number
	relationType: CausalLinkType
	strength: number
}

export interface ExtractedFact {
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

export const CHARS_PER_BATCH = 600_000

export interface PreparedExtractedFact {
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

export interface NormalizedBatchItem {
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

export interface ExpandedBatchContent {
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

export function parseISOToEpoch(
	iso: string | null | undefined
): number | null {
	if (!iso) return null
	const ms = new Date(iso).getTime()
	return Number.isNaN(ms) ? null : ms
}

export function mapFactType(value: unknown): FactType {
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

export function readString(value: unknown): string | null {
	return typeof value === 'string' &&
		value.trim().length > 0
		? sanitizeText(value).trim()
		: null
}

export function readIsoDate(value: unknown): string | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return new Date(value).toISOString()
	}
	const text = readString(value)
	if (!text) return null
	const ms = new Date(text).getTime()
	if (Number.isNaN(ms)) return null
	return new Date(ms).toISOString()
}

export function inferTemporalDate(
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

export function parseEntity(
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

export function parseCausalRelation(
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

function buildFactDedupKey(content: string): string {
	return sanitizeText(content)
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ')
}

function mergeUniqueStrings(
	current: string[],
	incoming: string[]
): string[] {
	return [...new Set([...current, ...incoming])]
}

function mergeUniqueEntities(
	current: ExtractedEntity[],
	incoming: ExtractedEntity[]
): ExtractedEntity[] {
	const merged = new Map<string, ExtractedEntity>()
	for (const entity of [...current, ...incoming]) {
		const key = `${entity.name.trim().toLowerCase()}|${entity.entityType}`
		if (merged.has(key)) continue
		merged.set(key, entity)
	}
	return [...merged.values()]
}

function cloneExtractedFact(
	fact: ExtractedFact
): ExtractedFact {
	return {
		...fact,
		entities: [...fact.entities],
		tags: [...fact.tags],
		causalRelations: []
	}
}

function mergeDuplicateFact(
	current: ExtractedFact,
	incoming: ExtractedFact
): void {
	current.confidence = Math.max(
		current.confidence,
		incoming.confidence
	)
	current.eventDate ||= incoming.eventDate
	current.occurredStart ||= incoming.occurredStart
	current.occurredEnd ||= incoming.occurredEnd
	current.mentionedAt ||= incoming.mentionedAt
	current.tags = mergeUniqueStrings(
		current.tags,
		incoming.tags
	)
	current.entities = mergeUniqueEntities(
		current.entities,
		incoming.entities
	)
}

function remapMergedCausalRelations(
	facts: ExtractedFact[],
	relationsByFact: Map<number, ExtractedCausalRelation[]>,
	oldToNewIndex: Map<number, number>
): void {
	for (
		let factIndex = 0;
		factIndex < facts.length;
		factIndex++
	) {
		const relations = relationsByFact.get(factIndex) ?? []
		const uniqueRelations = new Map<
			string,
			ExtractedCausalRelation
		>()
		for (const relation of relations) {
			const targetIndex = oldToNewIndex.get(
				relation.targetIndex
			)
			if (targetIndex == null) continue
			if (targetIndex >= factIndex) continue
			const key = `${targetIndex}|${relation.relationType}|${relation.strength}`
			if (uniqueRelations.has(key)) continue
			uniqueRelations.set(key, {
				...relation,
				targetIndex
			})
		}
		facts[factIndex]!.causalRelations = [
			...uniqueRelations.values()
		]
	}
}

export function dedupeExtractedFacts(
	facts: ExtractedFact[]
): ExtractedFact[] {
	if (facts.length < 2) return facts

	const dedupedFacts: ExtractedFact[] = []
	const dedupedIndexByKey = new Map<string, number>()
	const oldToNewIndex = new Map<number, number>()
	const relationsByFact = new Map<
		number,
		ExtractedCausalRelation[]
	>()

	for (
		let factIndex = 0;
		factIndex < facts.length;
		factIndex++
	) {
		const fact = facts[factIndex]!
		const key = buildFactDedupKey(fact.content)
		const existingIndex = dedupedIndexByKey.get(key)

		if (existingIndex == null) {
			const dedupedIndex = dedupedFacts.length
			dedupedFacts.push(cloneExtractedFact(fact))
			dedupedIndexByKey.set(key, dedupedIndex)
			oldToNewIndex.set(factIndex, dedupedIndex)
			relationsByFact.set(dedupedIndex, [
				...fact.causalRelations
			])
			continue
		}

		oldToNewIndex.set(factIndex, existingIndex)
		mergeDuplicateFact(dedupedFacts[existingIndex]!, fact)
		const existingRelations =
			relationsByFact.get(existingIndex) ?? []
		existingRelations.push(...fact.causalRelations)
		relationsByFact.set(existingIndex, existingRelations)
	}

	remapMergedCausalRelations(
		dedupedFacts,
		relationsByFact,
		oldToNewIndex
	)
	return dedupedFacts
}

export function normalizeExtractedFacts(
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
			readIsoDate(fact.occurred_start)
		let occurredEnd =
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

export function parseEventDateToEpoch(
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

export function mergeMetadata(
	base?: Record<string, unknown> | null,
	extra?: Record<string, unknown> | null
): Record<string, unknown> | null {
	if (!base && !extra) return null
	return {
		...base,
		...extra
	}
}

export function isTranscriptTurnArray(
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

export function normalizeContentInput(
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

export function normalizeBatchInputs(
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

export async function extractFactsFromContent(
	adapter: AnyTextAdapter,
	content: string,
	options: RetainOptions | RetainBatchOptions,
	context?: string | null,
	eventDateMs = Date.now(),
	chunkIndex = 0,
	totalChunks = 1
): Promise<ExtractedFact[]> {
	if ('facts' in options && options.facts) {
		return dedupeExtractedFacts(
			options.facts.map(f => ({
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
							.filter(
								(rel): rel is ExtractedCausalRelation =>
									Boolean(rel)
							)
					: []
			}))
		)
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
		return dedupeExtractedFacts(extracted)
	} catch {
		// Graceful degradation: LLM extraction failed, return empty result
		return []
	}
}

export function chunkTranscriptTurns(
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

export async function chunkWithChonkie(
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

export async function explodeBatchContents(
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

export function splitByCharacterBudget<
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
