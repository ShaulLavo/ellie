import { createCollection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { queryClient } from '../lib/query-client'
import { eden } from '../lib/eden'

/** Fact as returned by the Hindsight API. */
export interface MemoryFact {
	id: string
	bankId: string
	content: string
	factType: string
	confidence: number
	createdAt: number
	updatedAt: number
	tags: string[] | null
}

/** Entity as returned by the Hindsight API. */
export interface MemoryEntity {
	id: string
	bankId: string
	name: string
	entityType: string
	description: string | null
	firstSeen: number
	lastUpdated: number
}

/** Bank stats as returned by the Hindsight API. */
export interface BankStats {
	bankId: string
	nodeCounts: Record<string, number>
	linkCounts: Record<string, number>
}

const PAGE_SIZE = 30
const MAX_CACHED_PAGES = 20

// ── Pagination totals ──────────────────────────────────────────────────────
const factsTotals = new Map<string, number>()
const entitiesTotals = new Map<number, number>()

function evictOldest<K, V>(map: Map<K, V>, max: number) {
	if (map.size <= max) return
	const first = map.keys().next().value
	if (first !== undefined) map.delete(first)
}

export function getFactsTotal(
	page: number,
	filter: string
): number | undefined {
	return factsTotals.get(`${page}-${filter}`)
}

export function getEntitiesTotal(
	page: number
): number | undefined {
	return entitiesTotals.get(page)
}

// ── API helpers ─────────────────────────────────────────────────────────────

async function fetchFacts(
	bankId: string,
	opts: {
		limit: number
		offset: number
		factType?: string
	}
): Promise<{ facts: MemoryFact[]; total: number }> {
	const { data, error } = await eden
		.banks({ bankId })
		.memories.get({
			query: {
				limit: String(opts.limit),
				offset: String(opts.offset),
				factType: opts.factType as undefined
			}
		})
	if (error) throw error
	const result = data as unknown as {
		items: MemoryFact[]
		total: number
	}
	return {
		facts: result.items ?? [],
		total: result.total ?? 0
	}
}

async function fetchEntities(
	bankId: string,
	opts: { limit: number; offset: number }
): Promise<{ entities: MemoryEntity[]; total: number }> {
	const { data, error } = await eden
		.banks({ bankId })
		.entities.get({
			query: {
				limit: String(opts.limit),
				offset: String(opts.offset)
			}
		})
	if (error) throw error
	const result = data as unknown as {
		items: MemoryEntity[]
		total: number
	}
	return {
		entities: result.items ?? [],
		total: result.total ?? 0
	}
}

export async function fetchBankStats(
	bankId: string
): Promise<BankStats> {
	const { data, error } = await eden
		.banks({ bankId })
		.stats.get()
	if (error) throw error
	return data as unknown as BankStats
}

// ── Facts collections (paginated) ──────────────────────────────────────────

type FactsCollectionKey =
	`facts-${string}-${number}-${string}`
const factsCollections = new Map<
	FactsCollectionKey,
	ReturnType<typeof createFactsCollectionInner>
>()

function createFactsCollectionInner(
	bankId: string,
	page: number,
	filter: string
) {
	return createCollection(
		queryCollectionOptions<MemoryFact, string>({
			queryKey: ['memory', 'facts', bankId, page, filter],
			queryFn: async () => {
				const res = await fetchFacts(bankId, {
					limit: PAGE_SIZE,
					offset: page * PAGE_SIZE,
					factType: filter === 'all' ? undefined : filter
				})
				factsTotals.set(`${page}-${filter}`, res.total)
				evictOldest(factsTotals, MAX_CACHED_PAGES)
				return res.facts
			},
			queryClient,
			getKey: item => item.id
		})
	)
}

export function getFactsCollection(
	bankId: string,
	page: number,
	filter: string
) {
	const key: FactsCollectionKey = `facts-${bankId}-${page}-${filter}`
	let collection = factsCollections.get(key)
	if (!collection) {
		collection = createFactsCollectionInner(
			bankId,
			page,
			filter
		)
		evictOldest(factsCollections, MAX_CACHED_PAGES)
		factsCollections.set(key, collection)
	}
	return collection
}

// ── Entities collections (paginated) ───────────────────────────────────────

const entitiesCollections = new Map<
	number,
	ReturnType<typeof createEntitiesCollectionInner>
>()

function createEntitiesCollectionInner(
	bankId: string,
	page: number
) {
	return createCollection(
		queryCollectionOptions<MemoryEntity, string>({
			queryKey: ['memory', 'entities', bankId, page],
			queryFn: async () => {
				const res = await fetchEntities(bankId, {
					limit: PAGE_SIZE,
					offset: page * PAGE_SIZE
				})
				entitiesTotals.set(page, res.total)
				evictOldest(entitiesTotals, MAX_CACHED_PAGES)
				return res.entities
			},
			queryClient,
			getKey: item => item.id
		})
	)
}

export function getEntitiesCollection(
	bankId: string,
	page: number
) {
	let collection = entitiesCollections.get(page)
	if (!collection) {
		collection = createEntitiesCollectionInner(bankId, page)
		evictOldest(entitiesCollections, MAX_CACHED_PAGES)
		entitiesCollections.set(page, collection)
	}
	return collection
}

export { PAGE_SIZE }
