/**
 * Reconsolidation routing engine for ingest-time memory management.
 *
 * Replaces the binary dedup (keep/drop) with a 3-way routing decision:
 * - reinforce:     high similarity, no conflict → metadata-only update
 * - reconsolidate: moderate similarity or conflict → version snapshot + content update
 * - new_trace:     low similarity or no candidate → normal insert
 */

import { ulid } from '@ellie/utils'
import { eq, sql } from 'drizzle-orm'
import type { HindsightDatabase } from './db'
import type { EmbeddingStore } from './embedding'
import type { RetainRoute, RouteDecision } from './types'

// ── Constants ────────────────────────────────────────────────────────────────

export const REINFORCE_THRESHOLD = 0.92
export const RECONSOLIDATE_THRESHOLD = 0.78
const CANDIDATE_SEARCH_K = 5
const POLICY_VERSION = 'v1'

// ── Types ────────────────────────────────────────────────────────────────────

interface ExtractedEntity {
	name: string
	entityType: string
}

interface CandidateMatch {
	memoryId: string
	similarity: number
	eventAnchor: number
	entities: Array<{ name: string; entityType: string }>
}

export interface RoutingContext {
	hdb: HindsightDatabase
	memoryVec: EmbeddingStore
	bankId: string
	eventTime: number
	profile?: string | null
	project?: string | null
}

interface RoutingPolicy {
	reinforceThreshold?: number
	reconsolidateThreshold?: number
}

// ── Normalization helpers ────────────────────────────────────────────────────

function normalizeValue(s: string): string {
	const normalized = s.trim().toLowerCase().replace(/\s+/g, ' ')
	if (/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(normalized)) {
		const asNum = Number(normalized)
		if (Number.isFinite(asNum)) return String(asNum)
	}
	return normalized
}

// ── Core Classification ─────────────────────────────────────────────────────

export function classifyRoute(
	similarity: number,
	conflictDetected: boolean,
	policy: RoutingPolicy = {}
): RetainRoute {
	const reinforceThreshold = policy.reinforceThreshold ?? REINFORCE_THRESHOLD
	const reconsolidateThreshold = policy.reconsolidateThreshold ?? RECONSOLIDATE_THRESHOLD
	if (conflictDetected) return 'reconsolidate'
	if (similarity >= reinforceThreshold) {
		return 'reinforce'
	}
	if (similarity >= reconsolidateThreshold) {
		return 'reconsolidate'
	}
	return 'new_trace'
}

// ── Conflict Detection ──────────────────────────────────────────────────────

export function detectConflict(
	candidateEntities: Array<{ name: string; entityType: string }>,
	incomingEntities: ExtractedEntity[]
): { conflictDetected: boolean; conflictKeys: string[] } {
	if (candidateEntities.length === 0 || incomingEntities.length === 0) {
		return { conflictDetected: false, conflictKeys: [] }
	}

	const candidateMap = new Map<string, string>()
	for (const e of candidateEntities) {
		const key = `${normalizeValue(e.name)}|entity_type`
		candidateMap.set(key, normalizeValue(e.entityType))
	}

	const conflictKeys: string[] = []
	for (const e of incomingEntities) {
		const key = `${normalizeValue(e.name)}|entity_type`
		const incomingValue = normalizeValue(e.entityType)
		const existingType = candidateMap.get(key)
		if (existingType !== undefined && existingType !== incomingValue) {
			conflictKeys.push(key)
		}
	}

	return {
		conflictDetected: conflictKeys.length > 0,
		conflictKeys
	}
}

// ── Candidate Lookup ─────────────────────────────────────────────────────────

function loadCandidateEntities(
	hdb: HindsightDatabase,
	memoryId: string
): Array<{ name: string; entityType: string }> {
	const rows = hdb.sqlite
		.prepare(
			`SELECT e.name, e.entity_type as entityType
       FROM hs_memory_entities me
       JOIN hs_entities e ON e.id = me.entity_id
       WHERE me.memory_id = ?`
		)
		.all(memoryId) as Array<{ name: string; entityType: string }>
	return rows
}

function resolveMemoryAnchor(row: {
	eventDate: number | null
	occurredStart: number | null
	occurredEnd: number | null
	mentionedAt: number | null
	createdAt: number
}): number {
	return row.eventDate ?? row.occurredStart ?? row.occurredEnd ?? row.mentionedAt ?? row.createdAt
}

/**
 * Check whether a candidate memory's scope (profile/project) matches the
 * current routing context.
 *
 * When ctx.profile or ctx.project is set, this queries hs_episode_events for
 * the memory's most recent event. Memories created before the episode system
 * (migration 0002) have no event rows and return false — this is intentional.
 * No backfill is performed; scope filtering applies only going forward.
 */
function candidateScopeMatches(ctx: RoutingContext, memoryId: string): boolean {
	if (ctx.profile == null && ctx.project == null) return true
	const row = ctx.hdb.sqlite
		.prepare(
			`SELECT profile, project
       FROM hs_episode_events
       WHERE bank_id = ? AND memory_id = ?
       ORDER BY event_time DESC, id DESC
       LIMIT 1`
		)
		.get(ctx.bankId, memoryId) as { profile: string | null; project: string | null } | undefined
	if (!row) return false
	if (ctx.profile != null && row.profile !== ctx.profile) return false
	if (ctx.project != null && row.project !== ctx.project) return false
	return true
}

export function findBestCandidateByVector(
	ctx: RoutingContext,
	vector: Float32Array
): CandidateMatch | null {
	const hits = ctx.memoryVec.searchByVector(vector, CANDIDATE_SEARCH_K)

	for (const hit of hits) {
		const similarity = 1 - hit.distance

		const row = ctx.hdb.db
			.select({
				bankId: ctx.hdb.schema.memoryUnits.bankId,
				eventDate: ctx.hdb.schema.memoryUnits.eventDate,
				occurredStart: ctx.hdb.schema.memoryUnits.occurredStart,
				occurredEnd: ctx.hdb.schema.memoryUnits.occurredEnd,
				mentionedAt: ctx.hdb.schema.memoryUnits.mentionedAt,
				createdAt: ctx.hdb.schema.memoryUnits.createdAt
			})
			.from(ctx.hdb.schema.memoryUnits)
			.where(eq(ctx.hdb.schema.memoryUnits.id, hit.id))
			.get()
		if (!row || row.bankId !== ctx.bankId) continue
		if (!candidateScopeMatches(ctx, hit.id)) continue
		const eventAnchor = resolveMemoryAnchor(row)
		if (eventAnchor >= ctx.eventTime) continue

		const entities = loadCandidateEntities(ctx.hdb, hit.id)
		return {
			memoryId: hit.id,
			similarity,
			eventAnchor,
			entities
		}
	}
	return null
}

export async function findBestCandidateAsync(
	ctx: RoutingContext,
	content: string
): Promise<CandidateMatch | null> {
	const hits = await ctx.memoryVec.search(content, CANDIDATE_SEARCH_K)

	for (const hit of hits) {
		const similarity = 1 - hit.distance

		const row = ctx.hdb.db
			.select({
				bankId: ctx.hdb.schema.memoryUnits.bankId,
				eventDate: ctx.hdb.schema.memoryUnits.eventDate,
				occurredStart: ctx.hdb.schema.memoryUnits.occurredStart,
				occurredEnd: ctx.hdb.schema.memoryUnits.occurredEnd,
				mentionedAt: ctx.hdb.schema.memoryUnits.mentionedAt,
				createdAt: ctx.hdb.schema.memoryUnits.createdAt
			})
			.from(ctx.hdb.schema.memoryUnits)
			.where(eq(ctx.hdb.schema.memoryUnits.id, hit.id))
			.get()
		if (!row || row.bankId !== ctx.bankId) continue
		if (!candidateScopeMatches(ctx, hit.id)) continue
		const eventAnchor = resolveMemoryAnchor(row)
		if (eventAnchor >= ctx.eventTime) continue

		const entities = loadCandidateEntities(ctx.hdb, hit.id)
		return {
			memoryId: hit.id,
			similarity,
			eventAnchor,
			entities
		}
	}
	return null
}

// ── Route a single fact ──────────────────────────────────────────────────────

export function routeFactByVector(
	ctx: RoutingContext,
	incomingEntities: ExtractedEntity[],
	vector: Float32Array,
	policy: RoutingPolicy = {}
): RouteDecision {
	const candidate = findBestCandidateByVector(ctx, vector)
	if (!candidate) {
		return {
			route: 'new_trace',
			candidateMemoryId: null,
			candidateScore: null,
			conflictDetected: false,
			conflictKeys: []
		}
	}

	const { conflictDetected, conflictKeys } = detectConflict(candidate.entities, incomingEntities)
	const decidedRoute = classifyRoute(candidate.similarity, conflictDetected, policy)

	return {
		route: decidedRoute,
		candidateMemoryId: candidate.memoryId,
		candidateScore: candidate.similarity,
		conflictDetected,
		conflictKeys
	}
}

export async function routeFact(
	ctx: RoutingContext,
	content: string,
	incomingEntities: ExtractedEntity[],
	policy: RoutingPolicy = {}
): Promise<RouteDecision> {
	const candidate = await findBestCandidateAsync(ctx, content)
	if (!candidate) {
		return {
			route: 'new_trace',
			candidateMemoryId: null,
			candidateScore: null,
			conflictDetected: false,
			conflictKeys: []
		}
	}

	const { conflictDetected, conflictKeys } = detectConflict(candidate.entities, incomingEntities)
	const route = classifyRoute(candidate.similarity, conflictDetected, policy)

	return {
		route,
		candidateMemoryId: candidate.memoryId,
		candidateScore: candidate.similarity,
		conflictDetected,
		conflictKeys
	}
}

// ── Apply Route Actions ──────────────────────────────────────────────────────

export function applyReinforce(
	hdb: HindsightDatabase,
	candidateMemoryId: string,
	now: number
): void {
	hdb.db
		.update(hdb.schema.memoryUnits)
		.set({
			accessCount: sql`access_count + 1`,
			encodingStrength: sql`MIN(encoding_strength * 1.1, 3.0)`,
			lastAccessed: now,
			updatedAt: now
		})
		.where(eq(hdb.schema.memoryUnits.id, candidateMemoryId))
		.run()
}

export async function applyReconsolidate(
	hdb: HindsightDatabase,
	memoryVec: EmbeddingStore,
	candidateMemoryId: string,
	newContent: string,
	incomingEntities: ExtractedEntity[],
	reason: string,
	now: number
): Promise<void> {
	const current = hdb.db
		.select()
		.from(hdb.schema.memoryUnits)
		.where(eq(hdb.schema.memoryUnits.id, candidateMemoryId))
		.get()
	if (!current) return

	// Load current entity associations for the snapshot
	const currentEntities = loadCandidateEntities(hdb, candidateMemoryId)

	// Compute next version number
	const maxVersionRow = hdb.sqlite
		.prepare(
			`SELECT COALESCE(MAX(version_no), 0) as max_v FROM hs_memory_versions WHERE memory_id = ?`
		)
		.get(candidateMemoryId) as { max_v: number }
	const nextVersion = maxVersionRow.max_v + 1

	const allEntities = hdb.db
		.select()
		.from(hdb.schema.entities)
		.where(eq(hdb.schema.entities.bankId, current.bankId))
		.all()
	const entityKeyToId = new Map<string, string>()
	for (const entity of allEntities) {
		entityKeyToId.set(
			`${normalizeValue(entity.name)}|${normalizeValue(entity.entityType)}`,
			entity.id
		)
	}

	const mergedByName = new Map<string, { name: string; entityType: string }>()
	for (const entity of currentEntities) {
		mergedByName.set(normalizeValue(entity.name), {
			name: entity.name,
			entityType: entity.entityType
		})
	}
	for (const entity of incomingEntities) {
		mergedByName.set(normalizeValue(entity.name), {
			name: entity.name,
			entityType: entity.entityType
		})
	}

	const mergedEntityIds: string[] = []
	hdb.sqlite.run('BEGIN')
	try {
		hdb.db
			.insert(hdb.schema.memoryVersions)
			.values({
				id: ulid(),
				bankId: current.bankId,
				memoryId: candidateMemoryId,
				versionNo: nextVersion,
				content: current.content,
				entitiesJson: JSON.stringify(
					currentEntities.map((e) => ({ name: e.name, entityType: e.entityType }))
				),
				attributesJson: JSON.stringify({
					factType: current.factType,
					confidence: current.confidence,
					tags: current.tags,
					metadata: current.metadata
				}),
				reason,
				createdAt: now
			})
			.run()

		for (const entity of mergedByName.values()) {
			const key = `${normalizeValue(entity.name)}|${normalizeValue(entity.entityType)}`
			let entityId = entityKeyToId.get(key)
			if (!entityId) {
				entityId = ulid()
				hdb.db
					.insert(hdb.schema.entities)
					.values({
						id: entityId,
						bankId: current.bankId,
						name: entity.name,
						entityType: entity.entityType,
						description: null,
						metadata: null,
						mentionCount: 1,
						firstSeen: now,
						lastUpdated: now
					})
					.run()
				entityKeyToId.set(key, entityId)
			}
			mergedEntityIds.push(entityId)
		}

		hdb.db
			.update(hdb.schema.memoryUnits)
			.set({
				content: newContent,
				accessCount: sql`access_count + 1`,
				encodingStrength: sql`MIN(encoding_strength * 1.15, 3.0)`,
				lastAccessed: now,
				updatedAt: now
			})
			.where(eq(hdb.schema.memoryUnits.id, candidateMemoryId))
			.run()

		hdb.db
			.delete(hdb.schema.memoryEntities)
			.where(eq(hdb.schema.memoryEntities.memoryId, candidateMemoryId))
			.run()

		for (const entityId of mergedEntityIds) {
			hdb.db
				.insert(hdb.schema.memoryEntities)
				.values({ memoryId: candidateMemoryId, entityId })
				.run()
		}

		hdb.sqlite.run('DELETE FROM hs_memory_fts WHERE id = ?', [candidateMemoryId])
		hdb.sqlite.run('INSERT INTO hs_memory_fts (id, bank_id, content) VALUES (?, ?, ?)', [
			candidateMemoryId,
			current.bankId,
			newContent
		])

		// Update embedding before committing so we can roll back on failure
		await memoryVec.upsert(candidateMemoryId, newContent)

		hdb.sqlite.run('COMMIT')
	} catch (error) {
		hdb.sqlite.run('ROLLBACK')
		throw error
	}
}

// ── Decision Logging ─────────────────────────────────────────────────────────

export function logDecision(
	hdb: HindsightDatabase,
	bankId: string,
	decision: RouteDecision,
	appliedMemoryId: string,
	now: number
): void {
	hdb.db
		.insert(hdb.schema.reconsolidationDecisions)
		.values({
			id: ulid(),
			bankId,
			candidateMemoryId: decision.candidateMemoryId,
			appliedMemoryId,
			route: decision.route,
			candidateScore: decision.candidateScore,
			conflictDetected: decision.conflictDetected ? 1 : 0,
			conflictKeysJson:
				decision.conflictKeys.length > 0 ? JSON.stringify(decision.conflictKeys) : null,
			policyVersion: POLICY_VERSION,
			createdAt: now
		})
		.run()
}
