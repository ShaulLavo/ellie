import type {
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentRuntimeLimits,
	AssistantMessage
} from '../types'
import type { GuardrailState, RunContext } from './types'
import { createEmptyUsage } from './helpers'

export function createGuardrailState(): GuardrailState {
	return {
		startedAtMs: Date.now(),
		modelCallCount: 0,
		costUsd: 0,
		limitTriggered: false
	}
}

/** Returns true if a numeric limit is enabled (positive number). */
export function isLimitEnabled(
	value: number | undefined
): value is number {
	return value !== undefined && value > 0
}

/** Check all runtime limits and return the first one that is exceeded, or null. */
export function checkLimits(
	state: GuardrailState,
	limits: AgentRuntimeLimits | undefined
): AgentEvent | null {
	if (!limits || state.limitTriggered) return null

	if (
		isLimitEnabled(limits.maxModelCalls) &&
		state.modelCallCount > limits.maxModelCalls
	) {
		state.limitTriggered = true
		return {
			type: 'limit_hit',
			limit: 'max_model_calls',
			threshold: limits.maxModelCalls,
			observed: state.modelCallCount,
			usageSnapshot: {
				elapsedMs: Date.now() - state.startedAtMs,
				modelCalls: state.modelCallCount,
				costUsd: state.costUsd
			},
			scope: 'run',
			action: 'hard_stop'
		}
	}

	if (
		isLimitEnabled(limits.maxCostUsd) &&
		state.costUsd > limits.maxCostUsd
	) {
		state.limitTriggered = true
		return {
			type: 'limit_hit',
			limit: 'max_cost_usd',
			threshold: limits.maxCostUsd,
			observed: state.costUsd,
			usageSnapshot: {
				elapsedMs: Date.now() - state.startedAtMs,
				modelCalls: state.modelCallCount,
				costUsd: state.costUsd
			},
			scope: 'run',
			action: 'hard_stop'
		}
	}

	// Wall-clock is enforced via AbortSignal timeout, but also check here as a fallback
	if (isLimitEnabled(limits.maxWallClockMs)) {
		const elapsed = Date.now() - state.startedAtMs
		if (elapsed > limits.maxWallClockMs) {
			state.limitTriggered = true
			return {
				type: 'limit_hit',
				limit: 'max_wall_clock_ms',
				threshold: limits.maxWallClockMs,
				observed: elapsed,
				usageSnapshot: {
					elapsedMs: elapsed,
					modelCalls: state.modelCallCount,
					costUsd: state.costUsd
				},
				scope: 'run',
				action: 'hard_stop'
			}
		}
	}

	return null
}

/** Build a terminal assistant message for a limit hit. */
export function buildLimitTerminalMessage(
	limitEvent: Extract<AgentEvent, { type: 'limit_hit' }>,
	config: AgentLoopConfig,
	lastAssistantText?: string
): AssistantMessage {
	const snap = limitEvent.usageSnapshot
	let text = `Run stopped: ${limitEvent.limit} limit reached (threshold=${limitEvent.threshold}, observed=${limitEvent.observed}).`
	text += ` Usage: ${snap.elapsedMs}ms elapsed, ${snap.modelCalls} model calls, $${snap.costUsd.toFixed(4)} cost.`
	if (lastAssistantText) {
		const truncated =
			lastAssistantText.length > 200
				? lastAssistantText.slice(0, 200) + '…'
				: lastAssistantText
		text += ` Last progress: "${truncated}"`
	}
	return {
		role: 'assistant',
		content: [{ type: 'text', text }],
		provider: config.model.provider,
		model: config.model.id,
		usage: createEmptyUsage(),
		stopReason: 'error',
		errorMessage: `guardrail:${limitEvent.limit}`,
		timestamp: Date.now()
	}
}

/** Combine external abort signal with wall-clock timeout if configured. */
export function buildGuardrailSignal(
	externalSignal: AbortSignal | undefined,
	limits: AgentRuntimeLimits | undefined
): {
	signal: AbortSignal | undefined
	cleanup?: () => void
} {
	const wallClockMs = limits?.maxWallClockMs
	if (!isLimitEnabled(wallClockMs)) {
		return { signal: externalSignal }
	}

	const timeoutSignal = AbortSignal.timeout(wallClockMs)
	if (externalSignal) {
		return {
			signal: AbortSignal.any([
				externalSignal,
				timeoutSignal
			])
		}
	}
	return { signal: timeoutSignal }
}

/** Extract last assistant text from messages for limit terminal summary. */
export function extractLastAssistantText(
	messages: AgentMessage[]
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.role === 'assistant') {
			return (msg as AssistantMessage).content
				.filter(c => c.type === 'text')
				.map(c => c.text)
				.join('')
		}
	}
	return undefined
}

/**
 * Emit a limit_hit event, build a terminal assistant message, and end the run.
 * Centralises the exit sequence so every guardrail checkpoint uses the same path.
 */
export function emitLimitHitAndStop(
	limitEvent: AgentEvent,
	ctx: Pick<
		RunContext,
		| 'config'
		| 'currentContext'
		| 'newMessages'
		| 'emit'
		| 'stream'
	>
): void {
	const {
		config,
		currentContext,
		newMessages,
		emit,
		stream
	} = ctx
	emit(limitEvent)
	const lastText = extractLastAssistantText(newMessages)
	const termMsg = buildLimitTerminalMessage(
		limitEvent as Extract<
			AgentEvent,
			{ type: 'limit_hit' }
		>,
		config,
		lastText
	)
	emit({ type: 'message_start', message: termMsg })
	emit({ type: 'message_end', message: termMsg })
	currentContext.messages.push(termMsg)
	newMessages.push(termMsg)
	emit({
		type: 'turn_end',
		message: termMsg,
		toolResults: []
	})
	emit({ type: 'agent_end', messages: newMessages })
	stream.end(newMessages)
}
