/**
 * Tool result truncation — prevents oversized tool results from blowing the context window.
 *
 * Inspired by openclaw's tool-result-truncation.ts:
 * - Newline-aware cutting (don't break mid-line)
 * - Proportional budget across multiple text blocks
 * - Clear truncation suffix so the LLM knows content was cut
 *
 * Applied per-invocation: each tool result is truncated independently.
 * Default max: 50,000 characters per tool result.
 */

import type {
	BlobRef,
	BlobSink,
	TraceScope
} from '@ellie/trace'
import type { AgentToolResult } from './types'

// Types

export interface ToolSafetyOptions {
	/** Max chars for a single tool result. Default 50_000. Per-invocation. */
	maxToolResultChars: number
}

export interface TruncateBlobOverflowOptions {
	/** Traced blob sink for writing the full output. */
	blobSink: BlobSink
	/** Active trace scope for correlating the overflow blob. */
	traceScope: TraceScope
	/** Tool call ID for the blob role path. */
	toolCallId?: string
}

const DEFAULT_MAX_CHARS = 50_000
const MIN_KEEP_CHARS = 2_000
const TRUNCATION_SUFFIX =
	'\n\n---\n [Output truncated — showing first portion of result. Total output exceeded the maximum size limit.]'

// Public API

/**
 * Check if a tool result exceeds the max character limit.
 */
export function needsTruncation(
	result: AgentToolResult,
	maxChars: number = DEFAULT_MAX_CHARS
): boolean {
	const totalChars = countResultChars(result)
	return totalChars > maxChars
}

/**
 * Truncate a tool result to fit within the character limit.
 *
 * Strategy:
 * - If total text content is within limit, return unchanged
 * - For single text block: truncate at nearest newline
 * - For multiple text blocks: proportional budget per block
 * - Images are passed through unchanged (they don't consume text budget)
 */
export function truncateToolResult(
	result: AgentToolResult,
	maxChars: number = DEFAULT_MAX_CHARS
): AgentToolResult {
	const totalChars = countResultChars(result)
	if (totalChars <= maxChars) return result

	// Budget for text (subtract suffix length)
	const textBudget = Math.max(
		MIN_KEEP_CHARS,
		maxChars - TRUNCATION_SUFFIX.length
	)

	const truncatedContent = applyTruncation(
		result.content,
		textBudget,
		TRUNCATION_SUFFIX
	)

	return {
		...result,
		content: truncatedContent
	}
}

/**
 * Truncate a tool result with TUS-backed blob storage.
 *
 * Fail-closed: if blob writing fails, the error propagates.
 * The caller should catch and convert the tool call to an error result.
 */
export async function truncateToolResultWithBlob(
	result: AgentToolResult,
	maxChars: number = DEFAULT_MAX_CHARS,
	opts: TruncateBlobOverflowOptions
): Promise<AgentToolResult> {
	const totalChars = countResultChars(result)
	if (totalChars <= maxChars) return result

	// Collect full text for blob storage
	const fullText = result.content
		.filter(
			(c): c is { type: 'text'; text: string } =>
				c.type === 'text'
		)
		.map(c => c.text)
		.join('\n')

	// Write full output to TUS blob — throws on failure (fail-closed)
	const blobRef: BlobRef = await opts.blobSink.write({
		traceId: opts.traceScope.traceId,
		spanId: opts.traceScope.spanId,
		role: 'tool_result_full',
		content: fullText,
		mimeType: 'text/plain',
		ext: 'txt'
	})

	const suffix = `\n\n---\n [Output truncated — showing first portion of result. Full output stored as blob: ${blobRef.uploadId}]`

	// Budget for text (subtract suffix length)
	const textBudget = Math.max(
		MIN_KEEP_CHARS,
		maxChars - suffix.length
	)

	// Apply the same truncation logic as truncateToolResult
	const truncatedContent = applyTruncation(
		result.content,
		textBudget,
		suffix
	)

	const baseDetails =
		result.details && typeof result.details === 'object'
			? (result.details as Record<string, unknown>)
			: {}
	return {
		...result,
		content: truncatedContent,
		details: {
			...baseDetails,
			overflowRef: blobRef
		}
	}
}

// Internals

/**
 * Count total text characters in a tool result.
 */
function countResultChars(result: AgentToolResult): number {
	let total = 0
	for (const block of result.content) {
		if (block.type === 'text') {
			total += block.text.length
		}
	}
	return total
}

/**
 * Apply proportional truncation to content blocks.
 * Shared by both file-based and blob-based truncation paths.
 */
function applyTruncation(
	content: AgentToolResult['content'],
	textBudget: number,
	suffix: string
): AgentToolResult['content'] {
	const textBlocks: Array<{ index: number; text: string }> =
		[]
	for (let i = 0; i < content.length; i++) {
		const block = content[i]
		if (block.type === 'text') {
			textBlocks.push({ index: i, text: block.text })
		}
	}

	if (textBlocks.length === 0) return content

	const totalTextChars = textBlocks.reduce(
		(sum, b) => sum + b.text.length,
		0
	)

	const truncatedContent = [...content]
	let suffixAdded = false

	for (const block of textBlocks) {
		const blockShare = block.text.length / totalTextChars
		const blockBudget = Math.max(
			MIN_KEEP_CHARS,
			Math.floor(textBudget * blockShare)
		)

		if (block.text.length > blockBudget) {
			const truncatedText = truncateText(
				block.text,
				blockBudget
			)
			truncatedContent[block.index] = {
				type: 'text' as const,
				text: suffixAdded
					? truncatedText
					: truncatedText + suffix
			}
			suffixAdded = true
		}
	}

	// Safety: if no block was truncated but total exceeds
	if (
		!suffixAdded &&
		totalTextChars > textBudget + suffix.length
	) {
		const lastTextIdx =
			textBlocks[textBlocks.length - 1].index
		const lastContent = truncatedContent[lastTextIdx]
		if (lastContent.type === 'text') {
			truncatedContent[lastTextIdx] = {
				type: 'text' as const,
				text:
					truncateText(lastContent.text, textBudget) +
					suffix
			}
		}
	}

	return truncatedContent
}

/**
 * Truncate text to maxChars, preferring to cut at a newline boundary.
 *
 * Ported from openclaw's newline-aware cutting:
 * - Look for the last newline within 80% of the budget
 * - If found, cut there (cleaner output)
 * - Otherwise, cut at the budget boundary
 */
function truncateText(
	text: string,
	maxChars: number
): string {
	if (text.length <= maxChars) return text

	const keepChars = Math.max(MIN_KEEP_CHARS, maxChars)
	let cutPoint = keepChars

	// Look for a clean line break to cut at
	const lastNewline = text.lastIndexOf('\n', keepChars)
	if (lastNewline > keepChars * 0.8) {
		cutPoint = lastNewline
	}

	return text.slice(0, cutPoint)
}
