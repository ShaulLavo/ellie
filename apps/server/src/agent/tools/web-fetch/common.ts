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
