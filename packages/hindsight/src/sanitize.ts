/**
 * Text sanitization and lenient JSON parsing for LLM outputs.
 */

/**
 * Remove characters that break SQLite or are invalid UTF-8.
 *
 * - Null bytes (\x00) break SQLite text fields
 * - Lone surrogates (U+D800-U+DFFF) are invalid in UTF-8
 */
export function sanitizeText(text: string): string {
	// eslint-disable-next-line no-control-regex -- intentionally stripping null bytes
	return text.replace(/\0/g, '').replace(/[\uD800-\uDFFF]/gu, '')
}

/**
 * Parse JSON from LLM output, stripping markdown code fences if present.
 *
 * LLMs sometimes wrap their JSON response in ```json ... ``` fences.
 * This function handles that gracefully and returns a fallback value
 * if parsing fails entirely.
 */
export function parseLLMJson<T>(text: string, fallback: T): T {
	// Strip markdown code fences if present
	const cleaned = text
		.replace(/^```(?:json)?\s*\n?/m, '')
		.replace(/\n?```\s*$/m, '')
		.trim()

	try {
		return JSON.parse(cleaned) as T
	} catch {
		return fallback
	}
}
