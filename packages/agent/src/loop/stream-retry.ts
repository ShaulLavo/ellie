/**
 * Retry-aware stream processing.
 */

import { classifyError, isRetryable } from '@ellie/ai'
import { withRetry } from '../retry'
import { trimMessages } from '../context-recovery'
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	ToolResultMessage,
	StreamFn
} from '../types'
import type { ToolLoopDetector } from '../tool-loop-detection'
import type {
	EmitFn,
	GuardrailState,
	ProcessResult
} from './types'
import { createPartial } from './helpers'
import { isLimitEnabled } from './guardrails'
import { processAgentStream } from './stream-processing'

/**
 * Wrapper around processAgentStream that adds retry logic:
 * 1. Call processAgentStream as normal
 * 2. If result has error → classify it
 * 3. If not retryable (auth, billing, format) → return error immediately
 * 4. If requiresRecovery (context_overflow) → trim context, emit context_compacted
 * 5. If retryable without recovery (transient/rate_limit/timeout) → retry
 * 6. Pop the error assistant message before retry (zclaw's history_rollback pattern)
 *
 * The retry loop uses withRetry() for exponential backoff + jitter.
 */
export async function processAgentStreamWithRetry(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: EmitFn,
	streamFn?: StreamFn,
	loopDetector?: ToolLoopDetector,
	guardrailState?: GuardrailState
): Promise<ProcessResult> {
	const retryConfig = config.retry ?? {}
	const maxAttempts = retryConfig.maxAttempts ?? 3

	// If retry is disabled (maxAttempts=1), call directly
	// Note: the caller already incremented modelCallCount before calling us
	if (maxAttempts <= 1) {
		const directResult = await processAgentStream(
			context,
			config,
			signal,
			emit,
			streamFn,
			loopDetector
		)
		// Cost-based limit is best-effort: providers that don't report cost will never trigger it
		if (guardrailState) {
			guardrailState.costUsd +=
				directResult.lastAssistant.usage?.cost?.total ?? 0
		}
		return directResult
	}

	let lastResult: ProcessResult | undefined

	let isFirstAttempt = true

	const result = await withRetry(
		async () => {
			// The first attempt was already counted by the caller.
			// Only increment for retry attempts (2nd, 3rd, …).
			if (guardrailState && !isFirstAttempt) {
				guardrailState.modelCallCount++
			}
			isFirstAttempt = false

			// Guard: if limits are already exceeded (from cost/calls accumulated
			// during earlier attempts), bail out without making another model call.
			// We check the raw conditions here instead of calling checkLimits()
			// so the caller's unconditional post-call checkLimits() can properly
			// emit the limit_hit event with full context.
			if (guardrailState && config.runtimeLimits) {
				const lim = config.runtimeLimits
				const s = guardrailState
				const exceeded =
					(isLimitEnabled(lim.maxModelCalls) &&
						s.modelCallCount > lim.maxModelCalls) ||
					(isLimitEnabled(lim.maxCostUsd) &&
						s.costUsd > lim.maxCostUsd)
				if (exceeded) {
					const errorPartial = createPartial(config)
					errorPartial.stopReason = 'error'
					errorPartial.errorMessage =
						'guardrail:limit_exceeded'
					return {
						messages: [errorPartial] as AgentMessage[],
						toolResults: [] as ToolResultMessage[],
						lastAssistant: errorPartial,
						abortedOrError: true
					} satisfies ProcessResult
				}
			}

			const processResult = await processAgentStream(
				context,
				config,
				signal,
				emit,
				streamFn,
				loopDetector
			)

			// Accumulate cost from this attempt
			if (guardrailState) {
				guardrailState.costUsd +=
					processResult.lastAssistant.usage?.cost?.total ??
					0
			}

			// If no error, return successfully
			if (!processResult.abortedOrError) {
				return processResult
			}

			// Aborted by user — not retryable
			if (
				processResult.lastAssistant.stopReason === 'aborted'
			) {
				lastResult = processResult
				return processResult
			}

			// Classify the error
			const errorMessage =
				processResult.lastAssistant.errorMessage ?? ''
			const classified = classifyError(
				new Error(errorMessage)
			)

			// Not retryable — return the error result as-is
			if (!isRetryable(classified)) {
				lastResult = processResult
				return processResult
			}

			// --- Retryable error: prepare for retry ---

			// Pop the error assistant message AND its tool results from context
			// (zclaw's history_rollback pattern — don't let the LLM see its own error)
			const errorAssistant = processResult.lastAssistant
			const errorToolCallIds = new Set(
				errorAssistant.content
					.filter(b => b.type === 'toolCall')
					.map(
						b => (b as { type: 'toolCall'; id: string }).id
					)
			)
			// Remove both the error assistant and its orphaned tool results
			context.messages = context.messages.filter(
				m =>
					m !== errorAssistant &&
					!(
						m.role === 'toolResult' &&
						errorToolCallIds.has(
							(m as ToolResultMessage).toolCallId
						)
					)
			)

			// If recovery needed (context_overflow), trim context first
			if (classified.requiresRecovery) {
				const recoveryResult = trimMessages(
					context.messages,
					{
						contextWindow: config.model.contextWindow,
						safetyMargin:
							config.contextRecovery?.safetyMargin ?? 0.85,
						minPreservedMessages:
							config.contextRecovery
								?.minPreservedMessages ?? 4,
						charsPerToken:
							config.contextRecovery?.charsPerToken ?? 4
					}
				)

				if (recoveryResult.removedCount > 0) {
					context.messages = recoveryResult.messages
					emit({
						type: 'context_compacted',
						removedCount: recoveryResult.removedCount,
						remainingCount: recoveryResult.messages.length,
						estimatedTokens: recoveryResult.estimatedTokens
					})
				}
			}

			// Store result and throw to trigger retry
			lastResult = processResult

			// Create an error with retryAfterMs for the retry engine
			const retryError = new Error(
				errorMessage
			) as Error & {
				retryAfterMs?: number
			}
			if (classified.retryAfterMs) {
				retryError.retryAfterMs = classified.retryAfterMs
			}
			throw retryError
		},
		{
			maxAttempts,
			baseDelayMs: retryConfig.baseDelayMs ?? 1000,
			maxDelayMs: retryConfig.maxDelayMs ?? 30000,
			backoffMultiplier: retryConfig.backoffMultiplier ?? 2,
			signal,
			onRetry: (err, attempt, delayMs) => {
				const reason =
					err instanceof Error
						? err.message.slice(0, 200)
						: String(err)
				emit({
					type: 'retry',
					attempt,
					maxAttempts,
					reason,
					delayMs
				})
			}
		}
	).catch((err: unknown) => {
		// All retries exhausted (or shouldRetry returned false)
		// Return the last result if we have one, otherwise create an error result
		if (lastResult) return lastResult

		// Fallback: create a minimal error result
		const errorMessage =
			err instanceof Error ? err.message : String(err)
		const errorPartial = createPartial(config)
		errorPartial.stopReason = 'error'
		errorPartial.errorMessage = errorMessage
		return {
			messages: [] as AgentMessage[],
			toolResults: [] as ToolResultMessage[],
			lastAssistant: errorPartial,
			abortedOrError: true
		} satisfies ProcessResult
	})

	return result
}
