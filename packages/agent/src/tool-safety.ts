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

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentToolResult } from './types'

// ============================================================================
// Types
// ============================================================================

export interface ToolSafetyOptions {
	/** Max chars for a single tool result. Default 50_000. Per-invocation. */
	maxToolResultChars: number
}

export interface TruncateOverflowOptions {
	/** Directory to write full output files. If unset, full output is discarded. */
	overflowDir?: string
	/** Tool call ID used as the overflow filename. Falls back to Date.now(). */
	toolCallId?: string
}

const DEFAULT_MAX_CHARS = 50_000
const MIN_KEEP_CHARS = 2_000
const TRUNCATION_SUFFIX =
	'\n\n---\n [Output truncated — showing first portion of result. Total output exceeded the maximum size limit.]'

// ============================================================================
// Public API
// ============================================================================

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
	maxChars: number = DEFAULT_MAX_CHARS,
	overflow?: TruncateOverflowOptions
): AgentToolResult {
	const totalChars = countResultChars(result)
	if (totalChars <= maxChars) return result

	// Write full output to file before truncating
	let overflowPath: string | undefined
	if (overflow?.overflowDir) {
		try {
			mkdirSync(overflow.overflowDir, { recursive: true })
			const filename = `${overflow.toolCallId || Date.now()}.txt`
			overflowPath = join(overflow.overflowDir, filename)
			const fullText = result.content
				.filter(
					(c): c is { type: 'text'; text: string } =>
						c.type === 'text'
				)
				.map(c => c.text)
				.join('\n')
			writeFileSync(overflowPath, fullText, 'utf-8')
		} catch {
			// Best-effort — don't block truncation if write fails
			overflowPath = undefined
		}
	}

	const suffix = overflowPath
		? `\n\n---\n [Output truncated — showing first portion of result. Full output saved to: ${overflowPath}]`
		: TRUNCATION_SUFFIX

	// Budget for text (subtract suffix length)
	const textBudget = Math.max(
		MIN_KEEP_CHARS,
		maxChars - suffix.length
	)

	// Collect text blocks with their indices
	const textBlocks: Array<{
		index: number
		text: string
	}> = []
	for (let i = 0; i < result.content.length; i++) {
		const block = result.content[i]
		if (block.type === 'text') {
			textBlocks.push({ index: i, text: block.text })
		}
	}

	if (textBlocks.length === 0) return result

	// Calculate total text chars
	const totalTextChars = textBlocks.reduce(
		(sum, b) => sum + b.text.length,
		0
	)

	// Proportional budget per block
	const truncatedContent = [...result.content]
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

	// If no block was truncated but total exceeds (shouldn't happen, but safety)
	if (!suffixAdded && totalChars > maxChars) {
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

	const details = overflowPath
		? {
				...(result.details as Record<string, unknown>),
				overflowPath
			}
		: result.details

	return {
		...result,
		content: truncatedContent,
		details
	}
}

// ============================================================================
// Internals
// ============================================================================

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
