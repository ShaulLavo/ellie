/**
 * Context overflow recovery — trims oldest messages to fit within token budget.
 *
 * Inspired by nullclaw's forceCompressHistory() — force-trim without LLM summarization.
 * Keeps system prompt + last N messages, drops everything in between.
 *
 * Token estimation strategy (two-tier):
 * 1. Use real API token counts from the most recent AssistantMessage's usage.input
 *    (gives actual prompt token count from the API)
 * 2. Fall back to chars heuristic (charsPerToken configurable, default 4)
 *
 * Orphan prevention: when removing an assistant message with toolCall blocks,
 * also remove corresponding toolResult messages.
 */

import type {
	AgentMessage,
	AssistantMessage,
	ToolResultMessage
} from './types'

// ============================================================================
// Types
// ============================================================================

export interface ContextRecoveryOptions {
	/** From model registry — config.model.contextWindow */
	contextWindow: number
	/** Target usage ratio. Default 0.85 (85% of window). */
	safetyMargin: number
	/** Always keep at least this many recent messages. Default 4. */
	minPreservedMessages: number
	/** How many chars ≈ 1 token. Default 4. Configurable for code-heavy workloads. */
	charsPerToken: number
}

export interface ContextRecoveryResult {
	messages: AgentMessage[]
	removedCount: number
	estimatedTokens: number
}

const DEFAULT_OPTIONS: Omit<
	ContextRecoveryOptions,
	'contextWindow'
> = {
	safetyMargin: 0.85,
	minPreservedMessages: 4,
	charsPerToken: 4
}

// ============================================================================
// Token estimation
// ============================================================================

/**
 * Estimate the total token count for a message array.
 *
 * Strategy:
 * 1. Check the most recent assistant message for usage.input (real API count)
 * 2. If available and there are no newer messages after it, use that directly
 * 3. Otherwise, fall back to character-based estimation for all messages
 *
 * @param messages - The messages to estimate tokens for
 * @param charsPerToken - Characters per token ratio (default 4)
 */
export function estimateTokens(
	messages: AgentMessage[],
	charsPerToken: number = 4
): number {
	// Try to use real token counts from the most recent assistant message
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.role === 'assistant') {
			const assistantMsg = msg as AssistantMessage
			if (
				assistantMsg.usage &&
				assistantMsg.usage.input > 0
			) {
				// Real API count covers everything up to this message
				// Estimate any newer messages after it using chars heuristic
				const realTokens = assistantMsg.usage.input
				let additionalTokens = 0
				for (let j = i + 1; j < messages.length; j++) {
					additionalTokens += estimateMessageTokens(
						messages[j],
						charsPerToken
					)
				}
				return realTokens + additionalTokens
			}
		}
	}

	// Fallback: estimate all messages using chars heuristic
	let total = 0
	for (const msg of messages) {
		total += estimateMessageTokens(msg, charsPerToken)
	}
	return total
}

/**
 * Estimate tokens for a single message using character count heuristic.
 *
 * Adds 4 tokens overhead per message (role, separators).
 */
export function estimateMessageTokens(
	message: AgentMessage,
	charsPerToken: number = 4
): number {
	const overhead = 4 // role tokens + separators
	let chars = 0

	for (const block of message.content) {
		switch (block.type) {
			case 'text':
				chars += block.text.length
				break
			case 'thinking':
				chars += block.thinking.length
				break
			case 'toolCall':
				// Tool name + JSON args
				chars +=
					block.name.length +
					JSON.stringify(block.arguments).length
				break
			case 'image':
				// Images are typically ~1000 tokens regardless of size
				chars += 4000 // ~1000 tokens at 4 chars/token
				break
		}
	}

	// For toolResult messages, include toolName and toolCallId
	if (message.role === 'toolResult') {
		const toolMsg = message as ToolResultMessage
		chars += (toolMsg.toolName?.length ?? 0) + 40 // toolCallId ≈ 40 chars
	}

	return overhead + Math.ceil(chars / charsPerToken)
}

// ============================================================================
// Trimming
// ============================================================================

/**
 * Trim messages to fit within the context window budget.
 *
 * Strategy:
 * - Preserve the last minPreservedMessages messages always
 * - Remove oldest messages (user/assistant/toolResult) until under budget
 * - Orphan prevention: when removing an assistant message with toolCall blocks,
 *   also remove corresponding toolResult messages
 *
 * @param messages - All messages in the conversation
 * @param options - Recovery options including contextWindow
 */
export function trimMessages(
	messages: AgentMessage[],
	options: ContextRecoveryOptions
): ContextRecoveryResult {
	const opts = { ...DEFAULT_OPTIONS, ...options }
	const tokenBudget = Math.floor(
		opts.contextWindow * opts.safetyMargin
	)

	// If already within budget, return as-is
	const currentTokens = estimateTokens(
		messages,
		opts.charsPerToken
	)
	if (currentTokens <= tokenBudget) {
		return {
			messages: messages.slice(),
			removedCount: 0,
			estimatedTokens: currentTokens
		}
	}

	// Ensure we keep at least minPreservedMessages from the end
	const minKeep = Math.min(
		opts.minPreservedMessages,
		messages.length
	)

	// Start by keeping the last minKeep messages
	// Try progressively removing from the front
	let startIdx = 0
	const maxRemovable = messages.length - minKeep

	for (startIdx = 1; startIdx <= maxRemovable; startIdx++) {
		const candidate = messages.slice(startIdx)
		const est = estimateTokens(
			candidate,
			opts.charsPerToken
		)
		if (est <= tokenBudget) {
			// Clean up orphans in the kept messages
			const cleaned = removeOrphans(candidate)
			return {
				messages: cleaned,
				removedCount: messages.length - cleaned.length,
				estimatedTokens: estimateTokens(
					cleaned,
					opts.charsPerToken
				)
			}
		}
	}

	// If we can't fit even with maximum trimming, keep just the minimum
	const minimal = messages.slice(-minKeep)
	const cleaned = removeOrphans(minimal)
	return {
		messages: cleaned,
		removedCount: messages.length - cleaned.length,
		estimatedTokens: estimateTokens(
			cleaned,
			opts.charsPerToken
		)
	}
}

/**
 * Check if the current messages are approaching the context window limit.
 *
 * Useful for pre-emptive trimming before overflow actually occurs.
 */
export function isApproachingLimit(
	messages: AgentMessage[],
	contextWindow: number,
	safetyMargin: number = 0.85,
	charsPerToken: number = 4
): boolean {
	const budget = Math.floor(contextWindow * safetyMargin)
	const estimated = estimateTokens(messages, charsPerToken)
	return estimated > budget
}

// ============================================================================
// Orphan prevention
// ============================================================================

/**
 * Remove orphaned toolResult messages that reference assistant tool calls
 * no longer in the message array, and orphaned assistant messages that
 * have tool calls with no corresponding tool results.
 */
function removeOrphans(
	messages: AgentMessage[]
): AgentMessage[] {
	// Collect all toolCall IDs from assistant messages
	const toolCallIds = new Set<string>()
	for (const msg of messages) {
		if (msg.role === 'assistant') {
			for (const block of msg.content) {
				if (block.type === 'toolCall') {
					toolCallIds.add(block.id)
				}
			}
		}
	}

	// Collect all toolResult's toolCallIds
	const toolResultIds = new Set<string>()
	for (const msg of messages) {
		if (msg.role === 'toolResult') {
			const toolMsg = msg as ToolResultMessage
			toolResultIds.add(toolMsg.toolCallId)
		}
	}

	return messages.filter(msg => {
		// Remove toolResult messages that reference missing tool calls
		if (msg.role === 'toolResult') {
			const toolMsg = msg as ToolResultMessage
			return toolCallIds.has(toolMsg.toolCallId)
		}

		// Remove assistant messages that have tool calls with no results
		// (incomplete tool call/result pairs at the trim boundary)
		if (msg.role === 'assistant') {
			const assistantMsg = msg as AssistantMessage
			const hasToolCalls = assistantMsg.content.some(
				b => b.type === 'toolCall'
			)
			if (hasToolCalls) {
				// Check if ALL tool calls have corresponding results
				const allHaveResults = assistantMsg.content
					.filter(b => b.type === 'toolCall')
					.every(b =>
						toolResultIds.has(
							(b as { type: 'toolCall'; id: string }).id
						)
					)
				// Keep the message if it has text content even without tool results
				const hasTextContent = assistantMsg.content.some(
					b => b.type === 'text' && b.text.trim().length > 0
				)
				return allHaveResults || hasTextContent
			}
		}

		return true
	})
}
