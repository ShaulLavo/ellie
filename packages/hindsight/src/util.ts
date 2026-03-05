/** Clamp a numeric value to [min, max]. */
export function clamp(
	value: number,
	min: number,
	max: number
): number {
	return Math.max(min, Math.min(max, value))
}

/** Parse JSON safely, returning `fallback` on null input or parse failure. */
export function safeJsonParse<T>(
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
