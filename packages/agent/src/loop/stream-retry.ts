/**
 * Retry-aware stream processing.
 */

import type { ClassifiedError } from '@ellie/ai'
import { classifyError, isRetryable } from '@ellie/ai'
import { withRetry } from '../retry'
import { trimMessages } from '../context-recovery'
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AssistantMessage,
	ToolResultMessage
} from '../types'
import type {
	EmitFn,
	GuardrailState,
	ProcessResult,
	StreamContext
} from './types'
import { createPartial } from './helpers'
import { isLimitEnabled } from './guardrails'
import { processAgentStream } from './stream-processing'

// ---------------------------------------------------------------------------
// Extracted helpers — keep processAgentStreamWithRetry focused on orchestration
// ---------------------------------------------------------------------------

/** Check if guardrail limits are already exceeded; return an error result if so. */
function checkLimitExceeded(
	guardrailState: GuardrailState,
	config: AgentLoopConfig
): ProcessResult | null {
	const lim = config.runtimeLimits
	if (!lim) return null
	const s = guardrailState
	const exceeded =
		(isLimitEnabled(lim.maxModelCalls) &&
			s.modelCallCount > lim.maxModelCalls) ||
		(isLimitEnabled(lim.maxCostUsd) &&
			s.costUsd > lim.maxCostUsd)
	if (!exceeded) return null

	const errorPartial = createPartial(config)
	errorPartial.stopReason = 'error'
	errorPartial.errorMessage = 'guardrail:limit_exceeded'
	return {
		messages: [errorPartial] as AgentMessage[],
		toolResults: [] as ToolResultMessage[],
		lastAssistant: errorPartial,
		abortedOrError: true
	}
}

/**
 * Remove the error assistant message and its orphaned tool results
 * from context (zclaw's history_rollback pattern).
 */
function rollbackErrorMessages(
	context: AgentContext,
	errorAssistant: AssistantMessage
): void {
	const errorToolCallIds = new Set(
		errorAssistant.content
			.filter(b => b.type === 'toolCall')
			.map(b => (b as { type: 'toolCall'; id: string }).id)
	)
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
}

/** Trim context when a context_overflow recovery is needed. */
function attemptContextRecovery(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: EmitFn
): void {
	const recoveryResult = trimMessages(context.messages, {
		contextWindow: config.model.contextWindow,
		safetyMargin:
			config.contextRecovery?.safetyMargin ?? 0.85,
		minPreservedMessages:
			config.contextRecovery?.minPreservedMessages ?? 4,
		charsPerToken:
			config.contextRecovery?.charsPerToken ?? 4
	})
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

/** Build an Error that carries retryAfterMs for the retry engine. */
function buildRetryError(
	message: string,
	classified: ClassifiedError
): Error {
	const err = new Error(message) as Error & {
		retryAfterMs?: number
	}
	if (classified.retryAfterMs) {
		err.retryAfterMs = classified.retryAfterMs
	}
	return err
}

/** Create a fallback error ProcessResult when no lastResult is available. */
function buildFallbackErrorResult(
	err: unknown,
	config: AgentLoopConfig
): ProcessResult {
	const message =
		err instanceof Error ? err.message : String(err)
	const errorPartial = createPartial(config)
	errorPartial.stopReason = 'error'
	errorPartial.errorMessage = message
	return {
		messages: [] as AgentMessage[],
		toolResults: [] as ToolResultMessage[],
		lastAssistant: errorPartial,
		abortedOrError: true
	}
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

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
	sctx: StreamContext,
	guardrailState?: GuardrailState
): Promise<ProcessResult> {
	const {
		currentContext: context,
		config,
		signal,
		emit
	} = sctx
	const retryConfig = config.retry ?? {}
	const maxAttempts = retryConfig.maxAttempts ?? 3

	// If retry is disabled (maxAttempts=1), call directly
	if (maxAttempts <= 1) {
		const directResult = await processAgentStream(sctx)
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
			// Only increment modelCallCount for retry attempts (2nd, 3rd, …).
			if (guardrailState && !isFirstAttempt) {
				guardrailState.modelCallCount++
			}
			isFirstAttempt = false

			// Bail out if limits already exceeded from prior attempts
			if (guardrailState) {
				const limitResult = checkLimitExceeded(
					guardrailState,
					config
				)
				if (limitResult) return limitResult
			}

			const processResult = await processAgentStream(sctx)

			if (guardrailState) {
				guardrailState.costUsd +=
					processResult.lastAssistant.usage?.cost?.total ??
					0
			}
			if (!processResult.abortedOrError)
				return processResult
			if (
				processResult.lastAssistant.stopReason === 'aborted'
			) {
				lastResult = processResult
				return processResult
			}

			const errorMessage =
				processResult.lastAssistant.errorMessage ?? ''
			const classified = classifyError(
				new Error(errorMessage)
			)

			if (!isRetryable(classified)) {
				lastResult = processResult
				return processResult
			}

			// --- Retryable error: prepare for retry ---
			rollbackErrorMessages(
				context,
				processResult.lastAssistant
			)
			if (classified.requiresRecovery) {
				attemptContextRecovery(context, config, emit)
			}

			lastResult = processResult
			throw buildRetryError(errorMessage, classified)
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
		if (lastResult) return lastResult
		return buildFallbackErrorResult(err, config)
	})

	return result
}
