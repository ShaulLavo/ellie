import type { TagsMatch } from './types'

// ── Tag matching ──────────────────────────────────────────────────────────

/**
 * Check if a memory's tags match the filter tags according to the given mode.
 *
 * Modes:
 * - "any": memory has any matching tag OR is untagged (most permissive)
 * - "all": memory has ALL filter tags (untagged memories are included)
 * - "any_strict": memory has any matching tag (excludes untagged)
 * - "all_strict": memory has ALL filter tags (excludes untagged)
 */
export function matchesTags(
	memoryTags: string[],
	filterTags: string[],
	mode: TagsMatch
): boolean {
	if (filterTags.length === 0) return true

	const isUntagged = memoryTags.length === 0

	switch (mode) {
		case 'any':
			return (
				isUntagged ||
				memoryTags.some(t => filterTags.includes(t))
			)
		case 'all':
			return (
				isUntagged ||
				filterTags.every(t => memoryTags.includes(t))
			)
		case 'any_strict':
			return (
				!isUntagged &&
				memoryTags.some(t => filterTags.includes(t))
			)
		case 'all_strict':
			return (
				!isUntagged &&
				filterTags.every(t => memoryTags.includes(t))
			)
	}
}

/**
 * Parse a JSON-encoded string array, returning [] on malformed input.
 */
export function parseStringArray(
	raw: string | null
): string[] {
	if (!raw) return []

	try {
		const parsed = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		return parsed.filter(
			(value): value is string => typeof value === 'string'
		)
	} catch {
		return []
	}
}

/**
 * Check if raw JSON tags pass a tag filter.
 * Convenience wrapper combining parseStringArray + matchesTags.
 */
export function passesTagFilter(
	rawTags: string | null,
	filterTags?: string[],
	mode: TagsMatch = 'any'
): boolean {
	if (!filterTags || filterTags.length === 0) return true
	return matchesTags(
		parseStringArray(rawTags),
		filterTags,
		mode
	)
}
