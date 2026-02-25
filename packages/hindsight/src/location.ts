/**
 * Location-aware memory signals for code/workspace queries.
 *
 * Handles path normalization, location recording, access context tracking,
 * path association strength, and query-signal detection.
 */

import { ulid } from '@ellie/utils'
import { and, or, eq, desc, sql, inArray } from 'drizzle-orm'
import type { HindsightDatabase } from './db'

// ── Path normalization ──────────────────────────────────────────────────────

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

// ── Query signal detection ──────────────────────────────────────────────────

/**
 * Detect location signals in a recall query.
 *
 * Returns extracted path-like tokens from the query string:
 * - absolute paths: /a/b/c.ts
 * - relative paths: ./lib/x, src/foo.ts
 * - module-like tokens: foo/bar, utils.logger
 */
export function detectLocationSignals(query: string): string[] {
	const signals: string[] = []

	// Match file path patterns (absolute or relative)
	const pathRegex = /(?:^|\s)((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+(?:\.\w+)?)/g
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

// ── Location record/find/stats ──────────────────────────────────────────────

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
				eq(hdb.schema.locationPaths.normalizedPath, normalized),
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
		updateCoAccessAssociations(hdb, bankId, pathId, context.session, now)
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
	const conditions = [eq(hdb.schema.locationPaths.bankId, bankId)]

	if (input.scope?.profile) {
		conditions.push(eq(hdb.schema.locationPaths.profile, input.scope.profile))
	}
	if (input.scope?.project) {
		conditions.push(eq(hdb.schema.locationPaths.project, input.scope.project))
	}

	if (input.path) {
		const normalized = normalizePath(input.path)
		conditions.push(eq(hdb.schema.locationPaths.normalizedPath, normalized))
	}

	const pathRows = hdb.db
		.select()
		.from(hdb.schema.locationPaths)
		.where(and(...conditions))
		.limit(limit)
		.all()

	if (pathRows.length === 0 && input.query) {
		// Fall back to signal detection from query
		const signals = detectLocationSignals(input.query)
		if (signals.length > 0) {
			const normalizedSignals = signals.map(normalizePath)
			const signalConditions = [eq(hdb.schema.locationPaths.bankId, bankId)]
			if (input.scope?.profile) {
				signalConditions.push(eq(hdb.schema.locationPaths.profile, input.scope.profile))
			}
			if (input.scope?.project) {
				signalConditions.push(eq(hdb.schema.locationPaths.project, input.scope.project))
			}

			const allMatches: LocationHit[] = []
			for (const norm of normalizedSignals) {
				const matches = hdb.db
					.select()
					.from(hdb.schema.locationPaths)
					.where(
						and(
							...signalConditions,
							sql`${hdb.schema.locationPaths.normalizedPath} LIKE ${'%' + norm + '%'}`
						)
					)
					.limit(limit)
					.all()
				for (const row of matches) {
					allMatches.push(pathRowToHit(hdb, bankId, row))
				}
			}
			return allMatches.slice(0, limit)
		}
		return []
	}

	return pathRows.map((row) => pathRowToHit(hdb, bankId, row))
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
		conditions.push(eq(hdb.schema.locationPaths.profile, scope.profile))
	}
	if (scope?.project) {
		conditions.push(eq(hdb.schema.locationPaths.project, scope.project))
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
				eq(hdb.schema.locationAccessContexts.bankId, bankId),
				eq(hdb.schema.locationAccessContexts.pathId, pathRow.id)
			)
		)
		.all()

	const distinctMemoryIds = new Set(accessRows.map((r) => r.memoryId))

	// Get top associations (check both directions since canonical ordering may put this path as either source or related)
	const associations = hdb.db
		.select()
		.from(hdb.schema.locationAssociations)
		.where(
			and(
				eq(hdb.schema.locationAssociations.bankId, bankId),
				or(
					eq(hdb.schema.locationAssociations.sourcePathId, pathRow.id),
					eq(hdb.schema.locationAssociations.relatedPathId, pathRow.id)
				)
			)
		)
		.orderBy(desc(hdb.schema.locationAssociations.strength))
		.limit(5)
		.all()

	// For each association, the "related" path is whichever one isn't us
	const relatedPathIds = associations.map((a) =>
		a.sourcePathId === pathRow.id ? a.relatedPathId : a.sourcePathId
	)
	const relatedPaths =
		relatedPathIds.length > 0
			? hdb.db
					.select()
					.from(hdb.schema.locationPaths)
					.where(inArray(hdb.schema.locationPaths.id, relatedPathIds))
					.all()
			: []
	const relatedPathById = new Map(relatedPaths.map((p) => [p.id, p]))

	return {
		pathId: pathRow.id,
		rawPath: pathRow.rawPath,
		normalizedPath: pathRow.normalizedPath,
		accessCount: accessRows.length,
		lastAccessedAt: accessRows.length > 0 ? Math.max(...accessRows.map((r) => r.accessedAt)) : null,
		associatedMemoryCount: distinctMemoryIds.size,
		topAssociations: associations.map((a) => {
			const relatedId = a.sourcePathId === pathRow.id ? a.relatedPathId : a.sourcePathId
			return {
				relatedPathId: relatedId,
				relatedNormalizedPath: relatedPathById.get(relatedId)?.normalizedPath ?? '',
				coAccessCount: a.coAccessCount,
				strength: a.strength
			}
		})
	}
}

// ── Resolve query signals to path IDs ───────────────────────────────────────

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

	for (const signal of signals) {
		const normalized = normalizePath(signal)
		const conditions = [eq(hdb.schema.locationPaths.bankId, bankId)]
		if (scope?.profile) {
			conditions.push(eq(hdb.schema.locationPaths.profile, scope.profile))
		}
		if (scope?.project) {
			conditions.push(eq(hdb.schema.locationPaths.project, scope.project))
		}

		// Try exact match first
		const exact = hdb.db
			.select({ id: hdb.schema.locationPaths.id })
			.from(hdb.schema.locationPaths)
			.where(and(...conditions, eq(hdb.schema.locationPaths.normalizedPath, normalized)))
			.all()

		if (exact.length > 0) {
			result.set(
				signal,
				exact.map((r) => r.id)
			)
			continue
		}

		// Suffix match (e.g., "foo.ts" matches "/src/foo.ts")
		const suffix = hdb.db
			.select({ id: hdb.schema.locationPaths.id })
			.from(hdb.schema.locationPaths)
			.where(
				and(
					...conditions,
					sql`${hdb.schema.locationPaths.normalizedPath} LIKE ${'%/' + normalized}`
				)
			)
			.limit(5)
			.all()

		if (suffix.length > 0) {
			result.set(
				signal,
				suffix.map((r) => r.id)
			)
		}
	}

	return result
}

// ── Retrieval boost computation ─────────────────────────────────────────────

export interface LocationBoostInput {
	memoryId: string
	queryPathIds: Set<string>
	maxStrengthForQueryPaths: number
}

/**
 * Compute the location boost for a single memory candidate.
 *
 * directPathBoost: +0.12 if memory is directly associated with a query path
 * familiarityBoost: up to +0.10 based on access frequency and recency
 * coAccessBoost: up to +0.08 based on co-access strength between query and candidate paths
 */
export function computeLocationBoost(
	hdb: HindsightDatabase,
	bankId: string,
	memoryId: string,
	queryPathIds: Set<string>,
	maxStrengthForQueryPaths: number,
	now: number
): number {
	if (queryPathIds.size === 0) return 0

	// Find all paths associated with this memory via access contexts
	const memoryAccessRows = hdb.db
		.select({
			pathId: hdb.schema.locationAccessContexts.pathId,
			accessedAt: hdb.schema.locationAccessContexts.accessedAt
		})
		.from(hdb.schema.locationAccessContexts)
		.where(
			and(
				eq(hdb.schema.locationAccessContexts.bankId, bankId),
				eq(hdb.schema.locationAccessContexts.memoryId, memoryId)
			)
		)
		.all()

	if (memoryAccessRows.length === 0) return 0

	const candidatePathIds = new Set(memoryAccessRows.map((r) => r.pathId))

	// 1. directPathBoost: +0.12 if any candidate path exactly matches a query path
	let directPathBoost = 0
	for (const pathId of candidatePathIds) {
		if (queryPathIds.has(pathId)) {
			directPathBoost = 0.12
			break
		}
	}

	// 2. familiarityBoost: based on access count and recency
	const accessCountByPath = new Map<string, number>()
	const lastAccessByPath = new Map<string, number>()
	for (const row of memoryAccessRows) {
		accessCountByPath.set(row.pathId, (accessCountByPath.get(row.pathId) ?? 0) + 1)
		const prev = lastAccessByPath.get(row.pathId) ?? 0
		if (row.accessedAt > prev) lastAccessByPath.set(row.pathId, row.accessedAt)
	}

	let maxFamiliarityNorm = 0
	const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
	for (const pathId of candidatePathIds) {
		const count = accessCountByPath.get(pathId) ?? 0
		const lastAccess = lastAccessByPath.get(pathId) ?? 0
		const timeDelta = now - lastAccess
		const f = Math.log1p(count) * Math.exp(-timeDelta / thirtyDaysMs)
		const fNorm = f / (1 + f)
		if (fNorm > maxFamiliarityNorm) maxFamiliarityNorm = fNorm
	}
	const familiarityBoost = 0.1 * maxFamiliarityNorm

	// 3. coAccessBoost: from hs_location_associations
	let maxCoNorm = 0
	if (maxStrengthForQueryPaths > 0) {
		const candidatePathArray = [...candidatePathIds]
		if (candidatePathArray.length > 0) {
			const queryPathArray = [...queryPathIds]
			// Check both directions since canonical ordering may put query path as either source or related
			const assocs = hdb.db
				.select()
				.from(hdb.schema.locationAssociations)
				.where(
					and(
						eq(hdb.schema.locationAssociations.bankId, bankId),
						or(
							and(
								inArray(hdb.schema.locationAssociations.sourcePathId, queryPathArray),
								inArray(hdb.schema.locationAssociations.relatedPathId, candidatePathArray)
							),
							and(
								inArray(hdb.schema.locationAssociations.sourcePathId, candidatePathArray),
								inArray(hdb.schema.locationAssociations.relatedPathId, queryPathArray)
							)
						)
					)
				)
				.all()

			for (const assoc of assocs) {
				const coNorm = assoc.strength / maxStrengthForQueryPaths
				if (coNorm > maxCoNorm) maxCoNorm = coNorm
			}
		}
	}
	const coAccessBoost = 0.08 * maxCoNorm

	return directPathBoost + familiarityBoost + coAccessBoost
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
					inArray(hdb.schema.locationAssociations.sourcePathId, pathArray),
					inArray(hdb.schema.locationAssociations.relatedPathId, pathArray)
				)
			)
		)
		.get()

	return result?.maxStr ?? 0
}

// ── Internal helpers ────────────────────────────────────────────────────────

function pathRowToHit(
	hdb: HindsightDatabase,
	bankId: string,
	row: typeof import('./schema').locationPaths.$inferSelect
): LocationHit {
	const accessRows = hdb.db
		.select({ accessedAt: hdb.schema.locationAccessContexts.accessedAt })
		.from(hdb.schema.locationAccessContexts)
		.where(
			and(
				eq(hdb.schema.locationAccessContexts.bankId, bankId),
				eq(hdb.schema.locationAccessContexts.pathId, row.id)
			)
		)
		.all()

	return {
		pathId: row.id,
		rawPath: row.rawPath,
		normalizedPath: row.normalizedPath,
		profile: row.profile,
		project: row.project,
		accessCount: accessRows.length,
		lastAccessedAt:
			accessRows.length > 0 ? Math.max(...accessRows.map((r) => r.accessedAt)) : row.createdAt
	}
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
		.select({ pathId: hdb.schema.locationAccessContexts.pathId })
		.from(hdb.schema.locationAccessContexts)
		.where(
			and(
				eq(hdb.schema.locationAccessContexts.bankId, bankId),
				eq(hdb.schema.locationAccessContexts.session, session),
				sql`${hdb.schema.locationAccessContexts.accessedAt} >= ${cutoff}`,
				sql`${hdb.schema.locationAccessContexts.pathId} != ${currentPathId}`
			)
		)
		.all()

	const distinctPathIds = [...new Set(recentAccesses.map((r) => r.pathId))]

	for (const otherPathId of distinctPathIds) {
		// Canonical ordering: smaller ID first
		const [sourceId, relatedId] =
			currentPathId < otherPathId ? [currentPathId, otherPathId] : [otherPathId, currentPathId]

		// Atomic upsert: increment co_access_count or insert initial row.
		// Uses ON CONFLICT on the unique index (bank_id, source_path_id, related_path_id).
		// Strength is recomputed from the new count in a follow-up UPDATE since
		// SQLite's bundled math functions (log1p) are unavailable.
		// TODO: compile SQLite with -DSQLITE_ENABLE_MATH_FUNCTIONS to compute
		// strength entirely in SQL and collapse this into a single statement.
		const initStrength = Math.log1p(1) / (1 + Math.log1p(1))
		hdb.sqlite.run(
			`INSERT INTO hs_location_associations (id, bank_id, source_path_id, related_path_id, co_access_count, strength, updated_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?)
			 ON CONFLICT (bank_id, source_path_id, related_path_id) DO UPDATE SET
			   co_access_count = co_access_count + 1,
			   updated_at = ?`,
			[ulid(), bankId, sourceId, relatedId, initStrength, now, now]
		)

		// Read back the new count and recompute strength
		const row = hdb.sqlite
			.query<{ co_access_count: number; id: string }, [string, string, string]>(
				`SELECT id, co_access_count FROM hs_location_associations
				 WHERE bank_id = ? AND source_path_id = ? AND related_path_id = ?`
			)
			.get(bankId, sourceId, relatedId)
		if (row) {
			const strength = Math.log1p(row.co_access_count) / (1 + Math.log1p(row.co_access_count))
			hdb.sqlite.run(`UPDATE hs_location_associations SET strength = ? WHERE id = ?`, [
				strength,
				row.id
			])
		}
	}
}
