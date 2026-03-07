import type { AgentToolResult } from '@ellie/agent'

export const MAX_OUTPUT_CHARS = 50_000

export const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function truncateText(
	text: string,
	maxChars: number
): string {
	return text.length > maxChars
		? text.slice(0, maxChars) +
				`\n... (truncated at ${maxChars} chars)`
		: text
}

export function errorResult(msg: string): AgentToolResult {
	return {
		content: [
			{ type: 'text', text: `Web fetch error: ${msg}` }
		],
		details: { success: false, error: msg }
	}
}

export function isMediaType(contentType: string): boolean {
	return (
		contentType.startsWith('image/') ||
		contentType.startsWith('video/') ||
		contentType.startsWith('audio/')
	)
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024)
		return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── External content wrapping ───────────────────────────────────────────

const MARKER_START = '<<<EXTERNAL_UNTRUSTED_CONTENT>>>'
const MARKER_END = '<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>'

/** Fixed overhead added by wrapExternalContent: markers + "Source: web_fetch\n---\n" + newlines */
const WRAP_OVERHEAD =
	MARKER_START.length +
	MARKER_END.length +
	'Source: web_fetch\n---\n'.length +
	2 // newlines

/** Max content chars after reserving space for the wrapper. */
export const MAX_CONTENT_CHARS =
	MAX_OUTPUT_CHARS - WRAP_OVERHEAD

/**
 * Sanitize content to prevent marker spoofing — replace any literal
 * boundary markers found in the fetched content.
 */
function sanitizeMarkers(text: string): string {
	return text
		.replaceAll(MARKER_START, '[[MARKER_SANITIZED]]')
		.replaceAll(MARKER_END, '[[MARKER_SANITIZED]]')
}

/**
 * Wrap an AgentToolResult's text content with untrusted-content
 * boundary markers. Signals to the LLM that this content is external
 * and should not be treated as instructions.
 */
export function wrapExternalContent(
	result: AgentToolResult
): AgentToolResult {
	return {
		...result,
		content: result.content.map(block => {
			if (block.type !== 'text') return block
			const safe = sanitizeMarkers(block.text)
			return {
				type: 'text' as const,
				text: `${MARKER_START}\nSource: web_fetch\n---\n${safe}\n${MARKER_END}`
			}
		}),
		details: {
			...(result.details as Record<string, unknown>),
			externalContent: {
				untrusted: true,
				source: 'web_fetch'
			}
		}
	}
}
