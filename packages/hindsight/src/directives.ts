/**
 * Directives — hard behavioral rules injected into every reflect() prompt.
 *
 * Per-bank, prioritized, with tag-based isolation. Active directives are
 * injected at the top and bottom of the reflect system prompt for maximum
 * compliance (primacy + recency effect).
 */

import { ulid } from '@ellie/utils'
import { eq, and } from 'drizzle-orm'
import type { HindsightDatabase } from './db'
import type { Directive, CreateDirectiveOptions, UpdateDirectiveOptions, TagsMatch } from './types'
import type { DirectiveRow } from './schema'
import { matchesTags } from './recall'

// ── Helpers ────────────────────────────────────────────────────────────────

function rowToDirective(row: DirectiveRow): Directive {
	return {
		id: row.id,
		bankId: row.bankId,
		name: row.name,
		content: row.content,
		priority: row.priority,
		isActive: row.isActive === 1,
		tags: row.tags ? JSON.parse(row.tags) : null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	}
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export function createDirective(
	hdb: HindsightDatabase,
	bankId: string,
	options: CreateDirectiveOptions
): Directive {
	const id = ulid()
	const now = Date.now()

	hdb.db
		.insert(hdb.schema.directives)
		.values({
			id,
			bankId,
			name: options.name,
			content: options.content,
			priority: options.priority ?? 0,
			isActive: options.isActive === false ? 0 : 1,
			tags: options.tags ? JSON.stringify(options.tags) : null,
			createdAt: now,
			updatedAt: now
		})
		.run()

	return {
		id,
		bankId,
		name: options.name,
		content: options.content,
		priority: options.priority ?? 0,
		isActive: options.isActive !== false,
		tags: options.tags ?? null,
		createdAt: now,
		updatedAt: now
	}
}

export function getDirective(
	hdb: HindsightDatabase,
	bankId: string,
	id: string
): Directive | undefined {
	const row = hdb.db
		.select()
		.from(hdb.schema.directives)
		.where(and(eq(hdb.schema.directives.bankId, bankId), eq(hdb.schema.directives.id, id)))
		.get()
	return row ? rowToDirective(row) : undefined
}

export function listDirectives(
	hdb: HindsightDatabase,
	bankId: string,
	activeOnly: boolean = true
): Directive[] {
	const conditions = [eq(hdb.schema.directives.bankId, bankId)]
	if (activeOnly) {
		conditions.push(eq(hdb.schema.directives.isActive, 1))
	}

	return hdb.db
		.select()
		.from(hdb.schema.directives)
		.where(and(...conditions))
		.all()
		.sort((a, b) => {
			if (b.priority !== a.priority) return b.priority - a.priority
			return b.createdAt - a.createdAt
		})
		.map(rowToDirective)
}

export function updateDirective(
	hdb: HindsightDatabase,
	bankId: string,
	id: string,
	options: UpdateDirectiveOptions
): Directive {
	const now = Date.now()

	const updates: Record<string, unknown> = { updatedAt: now }

	if (options.name !== undefined) updates.name = options.name
	if (options.content !== undefined) updates.content = options.content
	if (options.priority !== undefined) updates.priority = options.priority
	if (options.isActive !== undefined) updates.isActive = options.isActive ? 1 : 0
	if (options.tags !== undefined) {
		updates.tags = options.tags === null ? null : JSON.stringify(options.tags)
	}

	hdb.db
		.update(hdb.schema.directives)
		.set(updates)
		.where(and(eq(hdb.schema.directives.bankId, bankId), eq(hdb.schema.directives.id, id)))
		.run()

	const row = hdb.db
		.select()
		.from(hdb.schema.directives)
		.where(and(eq(hdb.schema.directives.bankId, bankId), eq(hdb.schema.directives.id, id)))
		.get()

	if (!row) throw new Error(`Directive ${id} not found in bank ${bankId}`)
	return rowToDirective(row)
}

export function deleteDirective(hdb: HindsightDatabase, bankId: string, id: string): void {
	hdb.db
		.delete(hdb.schema.directives)
		.where(and(eq(hdb.schema.directives.bankId, bankId), eq(hdb.schema.directives.id, id)))
		.run()
}

// ── Reflect loader ────────────────────────────────────────────────────────

/**
 * Load active directives for injection into reflect() system prompt.
 *
 * Tag isolation logic:
 * - If `tags` provided: return directives matching those tags (via matchesTags)
 * - If no `tags`: only return tagless directives (prevents tag-scoped directives from leaking)
 *
 * Always active-only, ordered by priority DESC.
 */
export function loadDirectivesForReflect(
	hdb: HindsightDatabase,
	bankId: string,
	tags?: string[],
	tagsMatch?: TagsMatch
): Directive[] {
	const allActive = listDirectives(hdb, bankId, true)

	if (!tags || tags.length === 0) {
		// Isolation mode: only tagless directives
		return allActive.filter(d => !d.tags || d.tags.length === 0)
	}

	// Tag-aware mode: filter by tag matching
	// Exclude tagless directives — they should not leak into tag-scoped reflect
	return allActive.filter(d => {
		const directiveTags = d.tags ?? []
		if (directiveTags.length === 0) return false
		return matchesTags(directiveTags, tags, tagsMatch ?? 'any')
	})
}
