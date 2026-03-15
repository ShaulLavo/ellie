import { ulid } from 'fast-ulid'
import { eq } from 'drizzle-orm'
import type { HindsightDatabase } from './db'
import type { EmbeddingStore } from './embedding'
import type { Entity, EntityType } from './types'
import type { EntityRow } from './schema'
import { resolveEntity } from './entity-resolver'
import { rowToEntity } from './retain-db'
import { loadCooccurrences } from './retain-links'
import type {
	ExtractedEntity,
	PreparedExtractedFact
} from './retain-extract'

export interface EntityPlan {
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

export function processEntityForPlan(
	ent: ExtractedEntity,
	nearbyNames: string[],
	bankId: string,
	now: number,
	entityMap: Map<string, Entity>,
	entityById: Map<string, Entity>,
	newEntityById: Map<
		string,
		EntityPlan['newEntities'][number]
	>,
	existingMentionDeltas: Map<string, number>,
	newEntities: EntityPlan['newEntities'],
	existingEntities: EntityRow[],
	cooccurrences: Map<string, Set<string>>
): void {
	const key = `${ent.name.toLowerCase()}:${ent.entityType}`
	const seen = entityMap.get(key)
	if (seen) {
		const pending = newEntityById.get(seen.id)
		if (pending) {
			pending.mentionCount += 1
			return
		}
		existingMentionDeltas.set(
			seen.id,
			(existingMentionDeltas.get(seen.id) ?? 0) + 1
		)
		return
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
			row.name.toLowerCase() === ent.name.toLowerCase() &&
			row.entityType === ent.entityType
	)

	if (resolved || exactMatch) {
		const row =
			(resolved
				? existingEntities.find(
						entity => entity.id === resolved.entityId
					)
				: exactMatch) ?? null
		if (!row) return

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
		return
	}

	const entityId = ulid()
	const pendingEntity: EntityPlan['newEntities'][number] = {
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

export function planEntities(
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
			processEntityForPlan(
				ent,
				nearbyNames,
				bankId,
				now,
				entityMap,
				entityById,
				newEntityById,
				existingMentionDeltas,
				newEntities,
				existingEntities,
				cooccurrences
			)
		}
	}

	return {
		entityMap,
		entityById,
		existingMentionDeltas,
		newEntities
	}
}

export async function resolveOrCreateEntity(
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

export function resolveLinkedEntities(
	entities: ExtractedEntity[],
	entityMap: Map<string, Entity>,
	entityIdSet: Set<string>
): {
	linkedEntityIds: string[]
	linkedEntityNames: Set<string>
} {
	const linkedEntityIds: string[] = []
	const linkedEntityNames = new Set<string>()
	for (const ent of entities) {
		const key = `${ent.name.toLowerCase()}:${ent.entityType}`
		const entity = entityMap.get(key)
		if (!entity) continue
		linkedEntityIds.push(entity.id)
		linkedEntityNames.add(ent.name.toLowerCase())
		entityIdSet.add(entity.id)
	}
	return { linkedEntityIds, linkedEntityNames }
}
