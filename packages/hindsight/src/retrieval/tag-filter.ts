import type { TagsMatch } from '../types'

/**
 * Build the SQL condition and params for tag pre-filtering.
 *
 * @param tags - Tag values to match against
 * @param tagsMatch - Match mode (any, all, any_strict, all_strict)
 * @param column - Qualified column reference (e.g. "tags" or "mu.tags")
 */
export function buildTagCondition(
	tags: string[],
	tagsMatch: TagsMatch | undefined,
	column = 'tags'
): { condition: string; params: string[] } {
	const mode = tagsMatch ?? 'any'
	const tagPlaceholders = tags.map(() => '?').join(', ')

	let condition: string
	if (mode === 'any') {
		condition = `(${column} IS NULL OR EXISTS (
          SELECT 1 FROM json_each(${column}) je WHERE je.value IN (${tagPlaceholders})
        ))`
	} else if (mode === 'all') {
		condition = `(${column} IS NULL OR (
          SELECT COUNT(DISTINCT je.value) FROM json_each(${column}) je WHERE je.value IN (${tagPlaceholders})
        ) = ${tags.length})`
	} else if (mode === 'any_strict') {
		condition = `(${column} IS NOT NULL AND EXISTS (
          SELECT 1 FROM json_each(${column}) je WHERE je.value IN (${tagPlaceholders})
        ))`
	} else {
		condition = `(${column} IS NOT NULL AND (
          SELECT COUNT(DISTINCT je.value) FROM json_each(${column}) je WHERE je.value IN (${tagPlaceholders})
        ) = ${tags.length})`
	}

	return { condition, params: [...tags] }
}

/**
 * Build the SQL condition and named params for tag pre-filtering.
 *
 * Like `buildTagCondition` but uses `$tag_0`, `$tag_1`, ... named
 * placeholders so the result can be merged into a single named-param
 * object for `bun:sqlite`.
 *
 * @param tags - Tag values to match against
 * @param tagsMatch - Match mode (any, all, any_strict, all_strict)
 * @param column - Qualified column reference (e.g. "tags" or "mu.tags")
 */
export function buildNamedTagCondition(
	tags: string[],
	tagsMatch: TagsMatch | undefined,
	column = 'tags'
): { condition: string; params: Record<string, string> } {
	const mode = tagsMatch ?? 'any'
	const params: Record<string, string> = {}
	const tagPlaceholders = tags
		.map((tag, i) => {
			const key = `$tag_${i}`
			params[key] = tag
			return key
		})
		.join(', ')

	let condition: string
	if (mode === 'any') {
		condition = `(${column} IS NULL OR EXISTS (
          SELECT 1 FROM json_each(${column}) je WHERE je.value IN (${tagPlaceholders})
        ))`
	} else if (mode === 'all') {
		condition = `(${column} IS NULL OR (
          SELECT COUNT(DISTINCT je.value) FROM json_each(${column}) je WHERE je.value IN (${tagPlaceholders})
        ) = ${tags.length})`
	} else if (mode === 'any_strict') {
		condition = `(${column} IS NOT NULL AND EXISTS (
          SELECT 1 FROM json_each(${column}) je WHERE je.value IN (${tagPlaceholders})
        ))`
	} else {
		condition = `(${column} IS NOT NULL AND (
          SELECT COUNT(DISTINCT je.value) FROM json_each(${column}) je WHERE je.value IN (${tagPlaceholders})
        ) = ${tags.length})`
	}

	return { condition, params }
}
