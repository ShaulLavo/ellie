/**
 * Location-aware memory signals for code/workspace queries.
 *
 * Handles path normalization, location recording, access context tracking,
 * path association strength, and query-signal detection.
 */

import { ulid } from 'fast-ulid'
import {
	and,
	or,
	eq,
	desc,
	sql,
	inArray
} from 'drizzle-orm'
import type { HindsightDatabase } from './db'

/**
 * Normalize a file path for deterministic storage and matching.
 *
 * - trim whitespace
 * - replace backslashes with forward slashes
 * - collapse repeated slashes
 * - remove trailing slash (except root "/")
 * - lowercase for case-insensitive matching
 */
export function normalizePath(raw: string): string {
	let p = raw.trim()
	p = p.replace(/\\/g, '/')
	p = p.replace(/\/{2,}/g, '/')
	if (p.length > 1 && p.endsWith('/')) {
		p = p.slice(0, -1)
	}
	return p.toLowerCase()
}

/**
 * Detect location signals in a recall query.
 *
 * Returns extracted path-like tokens from the query string:
 * - absolute paths: /a/b/c.ts
 * - relative paths: ./lib/x, src/foo.ts
 * - module-like tokens: foo/bar, utils.logger
 */
export function detectLocationSignals(
	query: string
): string[] {
	const signals: string[] = []

	// Match file path patterns (absolute or relative)
	const pathRegex =
		/(?:^|\s)((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+(?:\.\w+)?)/g
	let match: RegExpExecArray | null
	while ((match = pathRegex.exec(query)) !== null) {
		const token = match[1]!.trim()
		if (token.length > 2) {
			signals.push(token)
		}
	}

	// Match module-like dot-separated tokens (e.g., utils.logger, foo.bar.baz)
	// but exclude common sentence patterns (e.g., "something. Something")
	const moduleRegex = /(?:^|\s)([\w-]+(?:\.[\w-]+){1,})/g
	while ((match = moduleRegex.exec(query)) !== null) {
		const token = match[1]!.trim()
		// Skip if it looks like a sentence boundary
		if (/\.[A-Z]/.test(token)) continue
		// Skip common non-module patterns
		if (/\d+\.\d+/.test(token)) continue // version numbers
		if (token.length > 2 && !signals.includes(token)) {
			signals.push(token)
		}
	}

	return signals
}

/**
 * Returns true if the query contains location signals.
 */
export function hasLocationSignals(query: string): boolean {
	return detectLocationSignals(query).length > 0
}

export interface LocationContext {
	memoryId: string
	session?: string
	activityType?: 'access' | 'retain' | 'recall'
}

export interface LocationHit {
	pathId: string
	rawPath: string
	normalizedPath: string
	profile: string
	project: string
	accessCount: number
	lastAccessedAt: number
}

export interface LocationStats {
	pathId: string
	rawPath: string
	normalizedPath: string
	accessCount: number
	lastAccessedAt: number | null
	associatedMemoryCount: number
	topAssociations: Array<{
		relatedPathId: string
		relatedNormalizedPath: string
		coAccessCount: number
		strength: number
	}>
}

/**
 * Record a location access event: upsert path, create access context, update associations.
 */
export function locationRecord(
	hdb: HindsightDatabase,
	bankId: string,
	rawPath: string,
	context: LocationContext,
	profile = 'default',
	project = 'default'
): void {
	const normalized = normalizePath(rawPath)
	const now = Date.now()

	// Upsert path
	const existingPath = hdb.db
		.select()
		.from(hdb.schema.locationPaths)
		.where(
			and(
				eq(hdb.schema.locationPaths.bankId, bankId),
				eq(
					hdb.schema.locationPaths.normalizedPath,
					normalized
				),
				eq(hdb.schema.locationPaths.profile, profile),
				eq(hdb.schema.locationPaths.project, project)
			)
		)
		.get()

	let pathId: string
	if (existingPath) {
		pathId = existingPath.id
		hdb.db
			.update(hdb.schema.locationPaths)
			.set({ updatedAt: now })
			.where(eq(hdb.schema.locationPaths.id, pathId))
			.run()
	} else {
		pathId = ulid()
		hdb.db
			.insert(hdb.schema.locationPaths)
			.values({
				id: pathId,
				bankId,
				rawPath,
				normalizedPath: normalized,
				profile,
				project,
				createdAt: now,
				updatedAt: now
			})
			.run()
	}

	// Create access context
	hdb.db
		.insert(hdb.schema.locationAccessContexts)
		.values({
			id: ulid(),
			bankId,
			pathId,
			memoryId: context.memoryId,
			session: context.session ?? null,
			activityType: context.activityType ?? 'access',
			accessedAt: now
		})
		.run()

	// Update co-access associations with other recently accessed paths in this session
	if (context.session) {
		updateCoAccessAssociations(
			hdb,
			bankId,
			pathId,
			context.session,
			now
		)
	}
}

/**
 * Find location paths matching a query or path pattern.
 */
export function locationFind(
	hdb: HindsightDatabase,
	bankId: string,
	input: {
		query?: string
		path?: string
		limit?: number
		scope?: { profile?: string; project?: string }
	}
): LocationHit[] {
	const limit = input.limit ?? 20
	const conditions = [
		eq(hdb.schema.locationPaths.bankId, bankId)
	]

	if (input.scope?.profile) {
		conditions.push(
			eq(
				hdb.schema.locationPaths.profile,
				input.scope.profile
			)
		)
	}
	if (input.scope?.project) {
		conditions.push(
			eq(
				hdb.schema.locationPaths.project,
				input.scope.project
			)
		)
	}

	if (input.path) {
		const normalized = normalizePath(input.path)
		conditions.push(
			eq(
				hdb.schema.locationPaths.normalizedPath,
				normalized
			)
		)
	}

	const pathRows = hdb.db
		.select()
		.from(hdb.schema.locationPaths)
		.where(and(...conditions))
		.limit(limit)
		.all()

	if (pathRows.length === 0 && input.query) {
		return findBySignalFallback(
			hdb,
			bankId,
			input.query,
			input.scope,
			limit
		)
	}

	return pathRowsToHits(hdb, bankId, pathRows)
}

/**
 * Get statistics for a specific path.
 */
export function locationStats(
	hdb: HindsightDatabase,
	bankId: string,
	rawPath: string,
	scope?: { profile?: string; project?: string }
): LocationStats | null {
	const normalized = normalizePath(rawPath)
	const conditions = [
		eq(hdb.schema.locationPaths.bankId, bankId),
		eq(hdb.schema.locationPaths.normalizedPath, normalized)
	]
	if (scope?.profile) {
		conditions.push(
			eq(hdb.schema.locationPaths.profile, scope.profile)
		)
	}
	if (scope?.project) {
		conditions.push(
			eq(hdb.schema.locationPaths.project, scope.project)
		)
	}

	const pathRow = hdb.db
		.select()
		.from(hdb.schema.locationPaths)
		.where(and(...conditions))
		.get()

	if (!pathRow) return null

	const accessRows = hdb.db
		.select()
		.from(hdb.schema.locationAccessContexts)
		.where(
			and(
				eq(
					hdb.schema.locationAccessContexts.bankId,
					bankId
				),
				eq(
					hdb.schema.locationAccessContexts.pathId,
					pathRow.id
				)
			)
		)
		.all()

	const distinctMemoryIds = new Set(
		accessRows.map(r => r.memoryId)
	)

	// Get top associations (check both directions since canonical ordering may put this path as either source or related)
	const associations = hdb.db
		.select()
		.from(hdb.schema.locationAssociations)
		.where(
			and(
				eq(hdb.schema.locationAssociations.bankId, bankId),
				or(
					eq(
						hdb.schema.locationAssociations.sourcePathId,
						pathRow.id
					),
					eq(
						hdb.schema.locationAssociations.relatedPathId,
						pathRow.id
					)
				)
			)
		)
		.orderBy(desc(hdb.schema.locationAssociations.strength))
		.limit(5)
		.all()

	// For each association, the "related" path is whichever one isn't us
	const relatedPathIds = associations.map(a =>
		a.sourcePathId === pathRow.id
			? a.relatedPathId
			: a.sourcePathId
	)
	const relatedPaths =
		relatedPathIds.length > 0
			? hdb.db
					.select()
					.from(hdb.schema.locationPaths)
					.where(
						inArray(
							hdb.schema.locationPaths.id,
							relatedPathIds
						)
					)
					.all()
			: []
	const relatedPathById = new Map(
		relatedPaths.map(p => [p.id, p])
	)

	return {
		pathId: pathRow.id,
		rawPath: pathRow.rawPath,
		normalizedPath: pathRow.normalizedPath,
		accessCount: accessRows.length,
		lastAccessedAt:
			accessRows.length > 0
				? Math.max(...accessRows.map(r => r.accessedAt))
				: null,
		associatedMemoryCount: distinctMemoryIds.size,
		topAssociations: associations.map(a => {
			const relatedId =
				a.sourcePathId === pathRow.id
					? a.relatedPathId
					: a.sourcePathId
			return {
				relatedPathId: relatedId,
				relatedNormalizedPath:
					relatedPathById.get(relatedId)?.normalizedPath ??
					'',
				coAccessCount: a.coAccessCount,
				strength: a.strength
			}
		})
	}
}

/**
 * Given location signals from a query, resolve them to known path IDs in the bank.
 */
export function resolveSignalsToPaths(
	hdb: HindsightDatabase,
	bankId: string,
	signals: string[],
	scope?: { profile?: string; project?: string }
): Map<string, string[]> {
	const result = new Map<string, string[]>()
	if (signals.length === 0) return result

	const baseConditions = [
		eq(hdb.schema.locationPaths.bankId, bankId)
	]
	if (scope?.profile) {
		baseConditions.push(
			eq(hdb.schema.locationPaths.profile, scope.profile)
		)
	}
	if (scope?.project) {
		baseConditions.push(
			eq(hdb.schema.locationPaths.project, scope.project)
		)
	}

	// Normalize all signals upfront and build signal→normalized map
	const signalToNorm = new Map<string, string>()
	const allNormalized: string[] = []
	for (const signal of signals) {
		const norm = normalizePath(signal)
		signalToNorm.set(signal, norm)
		allNormalized.push(norm)
	}

	// Batch exact match: one query for all normalized signals
	const exactRows = hdb.db
		.select({
			id: hdb.schema.locationPaths.id,
			normalizedPath:
				hdb.schema.locationPaths.normalizedPath
		})
		.from(hdb.schema.locationPaths)
		.where(
			and(
				...baseConditions,
				inArray(
					hdb.schema.locationPaths.normalizedPath,
					allNormalized
				)
			)
		)
		.all()

	// Group exact matches by normalizedPath
	const exactByNorm = new Map<string, string[]>()
	for (const row of exactRows) {
		let ids = exactByNorm.get(row.normalizedPath)
		if (!ids) {
			ids = []
			exactByNorm.set(row.normalizedPath, ids)
		}
		ids.push(row.id)
	}

	// Assign exact matches and collect unmatched signals for suffix search
	const unmatchedSignals: string[] = []
	for (const signal of signals) {
		const norm = signalToNorm.get(signal)!
		const ids = exactByNorm.get(norm)
		if (ids && ids.length > 0) {
			result.set(signal, ids)
		} else {
			unmatchedSignals.push(signal)
		}
	}

	// Batch suffix match for unmatched signals: one query with OR conditions
	if (unmatchedSignals.length > 0) {
		const suffixConditions = unmatchedSignals.map(
			signal => {
				const norm = signalToNorm.get(signal)!
				return sql`${hdb.schema.locationPaths.normalizedPath} LIKE ${'%/' + norm}`
			}
		)

		const suffixRows = hdb.db
			.select({
				id: hdb.schema.locationPaths.id,
				normalizedPath:
					hdb.schema.locationPaths.normalizedPath
			})
			.from(hdb.schema.locationPaths)
			.where(
				and(...baseConditions, or(...suffixConditions))
			)
			.all()

		// Match suffix rows back to signals
		for (const signal of unmatchedSignals) {
			const norm = signalToNorm.get(signal)!
			const suffix = '/' + norm
			const matched = suffixRows
				.filter(r => r.normalizedPath.endsWith(suffix))
				.slice(0, 5)
				.map(r => r.id)
			if (matched.length > 0) {
				result.set(signal, matched)
			}
		}
	}

	return result
}

/**
 * Batch-compute location boosts for multiple memory candidates.
 *
 * Prefetches all access contexts for the candidate set in one query,
 * then computes per-memory boosts in-memory. Eliminates N+1 queries
 * when called from the recall ranking loop.
 */
export function computeLocationBoostBatch(
	hdb: HindsightDatabase,
	bankId: string,
	memoryIds: string[],
	queryPathIds: Set<string>,
	maxStrengthForQueryPaths: number,
	now: number
): Map<string, number> {
	const result = new Map<string, number>()
	if (queryPathIds.size === 0 || memoryIds.length === 0)
		return result

	// Single query: fetch all access contexts for all candidate memories
	const allAccessRows = hdb.db
		.select({
			memoryId: hdb.schema.locationAccessContexts.memoryId,
			pathId: hdb.schema.locationAccessContexts.pathId,
			accessedAt:
				hdb.schema.locationAccessContexts.accessedAt
		})
		.from(hdb.schema.locationAccessContexts)
		.where(
			and(
				eq(
					hdb.schema.locationAccessContexts.bankId,
					bankId
				),
				inArray(
					hdb.schema.locationAccessContexts.memoryId,
					memoryIds
				)
			)
		)
		.all()

	// Group by memoryId
	const accessByMemory = new Map<
		string,
		Array<{ pathId: string; accessedAt: number }>
	>()
	const allCandidatePathIds = new Set<string>()
	for (const row of allAccessRows) {
		let rows = accessByMemory.get(row.memoryId)
		if (!rows) {
			rows = []
			accessByMemory.set(row.memoryId, rows)
		}
		rows.push({
			pathId: row.pathId,
			accessedAt: row.accessedAt
		})
		allCandidatePathIds.add(row.pathId)
	}

	// Prefetch all co-access associations between query paths and all candidate paths
	const coAccessMap = prefetchCoAccessStrengths(
		hdb,
		bankId,
		allCandidatePathIds,
		queryPathIds,
		maxStrengthForQueryPaths
	)

	const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000

	for (const memoryId of memoryIds) {
		const memoryAccessRows = accessByMemory.get(memoryId)
		if (
			!memoryAccessRows ||
			memoryAccessRows.length === 0
		) {
			continue
		}

		const candidatePathIds = new Set(
			memoryAccessRows.map(r => r.pathId)
		)

		// 1. directPathBoost
		let directPathBoost = 0
		for (const pathId of candidatePathIds) {
			if (queryPathIds.has(pathId)) {
				directPathBoost = 0.12
				break
			}
		}

		// 2. familiarityBoost
		const accessCountByPath = new Map<string, number>()
		const lastAccessByPath = new Map<string, number>()
		for (const row of memoryAccessRows) {
			accessCountByPath.set(
				row.pathId,
				(accessCountByPath.get(row.pathId) ?? 0) + 1
			)
			const prev = lastAccessByPath.get(row.pathId) ?? 0
			if (row.accessedAt > prev)
				lastAccessByPath.set(row.pathId, row.accessedAt)
		}

		let maxFamiliarityNorm = 0
		for (const pathId of candidatePathIds) {
			const count = accessCountByPath.get(pathId) ?? 0
			const lastAccess = lastAccessByPath.get(pathId) ?? 0
			const timeDelta = now - lastAccess
			const f =
				Math.log1p(count) *
				Math.exp(-timeDelta / thirtyDaysMs)
			const fNorm = f / (1 + f)
			if (fNorm > maxFamiliarityNorm)
				maxFamiliarityNorm = fNorm
		}
		const familiarityBoost = 0.1 * maxFamiliarityNorm

		// 3. coAccessBoost: use prefetched map
		let maxCoNorm = 0
		if (maxStrengthForQueryPaths > 0) {
			for (const pathId of candidatePathIds) {
				const strength = coAccessMap.get(pathId) ?? 0
				const coNorm = strength / maxStrengthForQueryPaths
				if (coNorm > maxCoNorm) maxCoNorm = coNorm
			}
		}
		const coAccessBoost = 0.08 * maxCoNorm

		const boost =
			directPathBoost + familiarityBoost + coAccessBoost
		if (boost > 0) {
			result.set(memoryId, boost)
		}
	}

	return result
}

/**
 * Get the maximum association strength for a set of query path IDs.
 * Used to normalize co-access boost.
 */
export function getMaxStrengthForPaths(
	hdb: HindsightDatabase,
	bankId: string,
	pathIds: Set<string>
): number {
	if (pathIds.size === 0) return 0
	const pathArray = [...pathIds]

	// Check both directions since canonical ordering may put path as either source or related
	const result = hdb.db
		.select({
			maxStr: sql<number>`MAX(${hdb.schema.locationAssociations.strength})`
		})
		.from(hdb.schema.locationAssociations)
		.where(
			and(
				eq(hdb.schema.locationAssociations.bankId, bankId),
				or(
					inArray(
						hdb.schema.locationAssociations.sourcePathId,
						pathArray
					),
					inArray(
						hdb.schema.locationAssociations.relatedPathId,
						pathArray
					)
				)
			)
		)
		.get()

	return result?.maxStr ?? 0
}

function findBySignalFallback(
	hdb: HindsightDatabase,
	bankId: string,
	query: string,
	scope: { profile?: string; project?: string } | undefined,
	limit: number
): LocationHit[] {
	const signals = detectLocationSignals(query)
	if (signals.length === 0) return []

	const normalizedSignals = signals.map(normalizePath)
	const baseConditions = [
		eq(hdb.schema.locationPaths.bankId, bankId)
	]
	if (scope?.profile) {
		baseConditions.push(
			eq(hdb.schema.locationPaths.profile, scope.profile)
		)
	}
	if (scope?.project) {
		baseConditions.push(
			eq(hdb.schema.locationPaths.project, scope.project)
		)
	}

	// Single query with OR for all signal LIKE conditions
	const likeConditions = normalizedSignals.map(
		norm =>
			sql`${hdb.schema.locationPaths.normalizedPath} LIKE ${'%' + norm + '%'}`
	)

	const matchedRows = hdb.db
		.select()
		.from(hdb.schema.locationPaths)
		.where(and(...baseConditions, or(...likeConditions)))
		.limit(limit)
		.all()

	return pathRowsToHits(hdb, bankId, matchedRows)
}

/**
 * Batch-convert path rows to LocationHits.
 * Fetches access contexts for all path IDs in one query.
 */
function pathRowsToHits(
	hdb: HindsightDatabase,
	bankId: string,
	rows: Array<
		typeof import('./schema').locationPaths.$inferSelect
	>
): LocationHit[] {
	if (rows.length === 0) return []

	const pathIds = rows.map(r => r.id)

	// Single query for all access contexts
	const allAccessRows = hdb.db
		.select({
			pathId: hdb.schema.locationAccessContexts.pathId,
			accessedAt:
				hdb.schema.locationAccessContexts.accessedAt
		})
		.from(hdb.schema.locationAccessContexts)
		.where(
			and(
				eq(
					hdb.schema.locationAccessContexts.bankId,
					bankId
				),
				inArray(
					hdb.schema.locationAccessContexts.pathId,
					pathIds
				)
			)
		)
		.all()

	// Build maps: pathId → count, pathId → maxAccessedAt
	const countByPath = new Map<string, number>()
	const maxAccessByPath = new Map<string, number>()
	for (const row of allAccessRows) {
		countByPath.set(
			row.pathId,
			(countByPath.get(row.pathId) ?? 0) + 1
		)
		const prev = maxAccessByPath.get(row.pathId) ?? 0
		if (row.accessedAt > prev)
			maxAccessByPath.set(row.pathId, row.accessedAt)
	}

	return rows.map(row => ({
		pathId: row.id,
		rawPath: row.rawPath,
		normalizedPath: row.normalizedPath,
		profile: row.profile,
		project: row.project,
		accessCount: countByPath.get(row.id) ?? 0,
		lastAccessedAt:
			maxAccessByPath.get(row.id) ?? row.createdAt
	}))
}

/**
 * Prefetch co-access strengths between a set of candidate paths and query paths.
 * Returns a map of candidatePathId → max strength with any query path.
 */
function prefetchCoAccessStrengths(
	hdb: HindsightDatabase,
	bankId: string,
	candidatePathIds: Set<string>,
	queryPathIds: Set<string>,
	maxStrengthForQueryPaths: number
): Map<string, number> {
	const result = new Map<string, number>()
	if (
		maxStrengthForQueryPaths <= 0 ||
		candidatePathIds.size === 0
	)
		return result

	const candidatePathArray = [...candidatePathIds]
	const queryPathArray = [...queryPathIds]

	const assocs = hdb.db
		.select()
		.from(hdb.schema.locationAssociations)
		.where(
			and(
				eq(hdb.schema.locationAssociations.bankId, bankId),
				or(
					and(
						inArray(
							hdb.schema.locationAssociations.sourcePathId,
							queryPathArray
						),
						inArray(
							hdb.schema.locationAssociations.relatedPathId,
							candidatePathArray
						)
					),
					and(
						inArray(
							hdb.schema.locationAssociations.sourcePathId,
							candidatePathArray
						),
						inArray(
							hdb.schema.locationAssociations.relatedPathId,
							queryPathArray
						)
					)
				)
			)
		)
		.all()

	for (const assoc of assocs) {
		// Determine which side is the candidate path
		const candidateId = queryPathIds.has(assoc.sourcePathId)
			? assoc.relatedPathId
			: assoc.sourcePathId
		const prev = result.get(candidateId) ?? 0
		if (assoc.strength > prev) {
			result.set(candidateId, assoc.strength)
		}
	}

	return result
}

/**
 * Update co-access associations when a path is accessed within a session.
 * Find other paths accessed in the same session within a recent window and
 * increment their co-access counts.
 */
function updateCoAccessAssociations(
	hdb: HindsightDatabase,
	bankId: string,
	currentPathId: string,
	session: string,
	now: number
): void {
	const windowMs = 30 * 60 * 1000 // 30 minute window
	const cutoff = now - windowMs

	// Find other paths accessed in this session within the window
	const recentAccesses = hdb.db
		.select({
			pathId: hdb.schema.locationAccessContexts.pathId
		})
		.from(hdb.schema.locationAccessContexts)
		.where(
			and(
				eq(
					hdb.schema.locationAccessContexts.bankId,
					bankId
				),
				eq(
					hdb.schema.locationAccessContexts.session,
					session
				),
				sql`${hdb.schema.locationAccessContexts.accessedAt} >= ${cutoff}`,
				sql`${hdb.schema.locationAccessContexts.pathId} != ${currentPathId}`
			)
		)
		.all()

	const distinctPathIds = [
		...new Set(recentAccesses.map(r => r.pathId))
	]

	for (const otherPathId of distinctPathIds) {
		// Canonical ordering: smaller ID first
		const [sourceId, relatedId] =
			currentPathId < otherPathId
				? [currentPathId, otherPathId]
				: [otherPathId, currentPathId]

		// Atomic upsert: increment co_access_count or insert initial row.
		// Strength is recomputed from the new count in a follow-up UPDATE since
		// SQLite's bundled math functions (log1p) are unavailable.
		const { locationAssociations: la } = hdb.schema
		const initStrength = Math.log1p(1) / (1 + Math.log1p(1))
		hdb.db
			.insert(la)
			.values({
				id: ulid(),
				bankId,
				sourcePathId: sourceId,
				relatedPathId: relatedId,
				coAccessCount: 1,
				strength: initStrength,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: [
					la.bankId,
					la.sourcePathId,
					la.relatedPathId
				],
				set: {
					coAccessCount: sql`co_access_count + 1`,
					updatedAt: now
				}
			})
			.run()

		// Read back the new count and recompute strength
		const row = hdb.db
			.select({
				id: la.id,
				coAccessCount: la.coAccessCount
			})
			.from(la)
			.where(
				and(
					eq(la.bankId, bankId),
					eq(la.sourcePathId, sourceId),
					eq(la.relatedPathId, relatedId)
				)
			)
			.get()
		if (row) {
			const strength =
				Math.log1p(row.coAccessCount) /
				(1 + Math.log1p(row.coAccessCount))
			hdb.db
				.update(la)
				.set({ strength })
				.where(eq(la.id, row.id))
				.run()
		}
	}
}
