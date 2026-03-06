/**
 * Main loop — the outer loop shared by agentLoop and agentLoopContinue.
 *
 * TanStack AI handles the tool-call loop internally via maxIterations().
 * This outer loop handles steering and follow-up messages.
 */

import { EventStream } from '../event-stream'
import { createToolLoopDetector } from '../tool-loop-detection'
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	ToolCall,
	ToolResultMessage,
	StreamFn
} from '../types'
import type {
	EmitFn,
	ProcessResult,
	RunContext
} from './types'
import {
	createGuardrailState,
	buildGuardrailSignal,
	checkLimits,
	isLimitEnabled,
	emitLimitHitAndStop
} from './guardrails'
import { executeToolCall } from './tool-execution'
import { processAgentStreamWithRetry } from './stream-retry'

// ---------------------------------------------------------------------------
// Helpers (extracted to reduce nesting depth in runLoop)
// ---------------------------------------------------------------------------

/**
 * Emit skipped tool results for remaining tool calls when steering
 * interrupts execution mid-iteration.
 */
function emitSkippedToolResults(
	toolCalls: ToolCall[],
	startIndex: number,
	ctx: RunContext
): void {
	const { emit, currentContext, newMessages } = ctx
	for (let j = startIndex; j < toolCalls.length; j++) {
		const remaining = toolCalls[j]
		const skipResult: ToolResultMessage = {
			role: 'toolResult',
			toolCallId: remaining.id,
			toolName: remaining.name,
			content: [
				{
					type: 'text',
					text: 'Tool execution skipped due to steering'
				}
			],
			isError: true,
			timestamp: Date.now()
		}
		emit({
			type: 'tool_execution_start',
			toolCallId: remaining.id,
			toolName: remaining.name,
			args: remaining.arguments
		})
		emit({
			type: 'tool_execution_end',
			toolCallId: remaining.id,
			toolName: remaining.name,
			result: {
				content: skipResult.content,
				details: {}
			},
			isError: true
		})
		emit({ type: 'message_start', message: skipResult })
		emit({ type: 'message_end', message: skipResult })
		currentContext.messages.push(skipResult)
		newMessages.push(skipResult)
	}
}

/**
 * Execute tool calls from an assistant message, checking for steering
 * between each execution. Returns any pending steering messages if
 * steering interrupted the execution, or an empty array otherwise.
 */
async function executeToolCallsWithSteering(
	toolCalls: ToolCall[],
	ctx: RunContext
): Promise<AgentMessage[]> {
	const {
		currentContext,
		newMessages,
		config,
		signal,
		emit,
		loopDetector
	} = ctx
	for (let i = 0; i < toolCalls.length; i++) {
		if (signal?.aborted) break

		const midSteering =
			(await config.getSteeringMessages?.()) || []
		if (midSteering.length > 0) {
			emitSkippedToolResults(toolCalls, i, ctx)
			return midSteering
		}

		const toolResults = await executeToolCall(
			toolCalls[i],
			currentContext.tools ?? [],
			signal,
			emit,
			config.toolSafety?.maxToolResultChars ?? 50_000,
			loopDetector,
			config.toolSafety?.blobSink,
			config.toolSafety?.traceScope
		)
		for (const tr of toolResults) {
			currentContext.messages.push(tr)
			newMessages.push(tr)
		}
	}
	return []
}

interface ToolLoopOutcome {
	/** Updated result after the tool loop completes. */
	result: ProcessResult
	/** Pending steering messages to inject on next turn, if any. */
	pendingMessages: AgentMessage[]
	/** True when runLoop should return immediately (limit hit). */
	shouldReturn: boolean
}

/**
 * When using streamFn, run the manual tool-execution loop: execute tool
 * calls, check guardrails, and re-call the LLM until the assistant stops
 * requesting tools or a limit is reached.
 */
async function runToolLoop(
	result: ProcessResult,
	ctx: RunContext
): Promise<ToolLoopOutcome> {
	const { newMessages, config, signal, guardrailState } =
		ctx
	let current = result
	let iterations = 0
	const maxTurns = config.maxTurns ?? 10
	const limits = config.runtimeLimits

	while (
		!current.abortedOrError &&
		current.lastAssistant.stopReason === 'toolUse' &&
		iterations < maxTurns
	) {
		iterations++

		// --- Guardrail check: before tool execution iteration ---
		const toolIterLimitEvent = checkLimits(
			guardrailState,
			limits
		)
		if (toolIterLimitEvent) {
			emitLimitHitAndStop(toolIterLimitEvent, ctx)
			return {
				result: current,
				pendingMessages: [],
				shouldReturn: true
			}
		}

		const toolCalls = current.lastAssistant.content.filter(
			(c): c is ToolCall => c.type === 'toolCall'
		)

		const steering = await executeToolCallsWithSteering(
			toolCalls,
			ctx
		)
		if (steering.length > 0) {
			return {
				result: current,
				pendingMessages: steering,
				shouldReturn: false
			}
		}

		if (signal?.aborted) break

		// --- Guardrail check: before re-call ---
		guardrailState.modelCallCount++
		const reCallLimitEvent = checkLimits(
			guardrailState,
			limits
		)
		if (reCallLimitEvent) {
			emitLimitHitAndStop(reCallLimitEvent, ctx)
			return {
				result: current,
				pendingMessages: [],
				shouldReturn: true
			}
		}

		// Re-call the LLM with tool results (with retry)
		current = await processAgentStreamWithRetry(
			ctx,
			guardrailState
		)
		for (const msg of current.messages) {
			newMessages.push(msg)
		}
	}

	return {
		result: current,
		pendingMessages: [],
		shouldReturn: false
	}
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
export async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	emit: EmitFn,
	streamFn?: StreamFn
): Promise<void> {
	// Create tool loop detector for the entire run
	const loopDetector = createToolLoopDetector(
		config.toolLoopDetection
	)

	// Create guardrail runtime state
	const guardrailState = createGuardrailState()
	const limits = config.runtimeLimits

	// Build combined signal for wall-clock timeout
	const { signal: guardedSignal } = buildGuardrailSignal(
		signal,
		limits
	)

	// Use the guarded signal throughout the loop (falls back to original if no wall-clock limit)
	const effectiveSignal = guardedSignal ?? signal

	// Build the shared run context
	// `signal` is the effective (guarded) signal for stream processing;
	// `userSignal` preserves the original for wall-clock timeout detection.
	const ctx: RunContext = {
		currentContext,
		newMessages,
		config,
		signal: effectiveSignal,
		emit,
		streamFn,
		stream,
		guardrailState,
		loopDetector,
		userSignal: signal
	}

	let firstTurn = true
	let pendingMessages: AgentMessage[] =
		(await config.getSteeringMessages?.()) || []

	// Outer loop: continues when steering or follow-up messages arrive
	while (true) {
		if (!firstTurn) {
			emit({ type: 'turn_start' })
		} else {
			firstTurn = false
		}

		// Inject pending messages before next assistant response
		if (pendingMessages.length > 0) {
			for (const message of pendingMessages) {
				emit({ type: 'message_start', message })
				emit({ type: 'message_end', message })
				currentContext.messages.push(message)
				newMessages.push(message)
			}
			pendingMessages = []
		}

		// --- Guardrail check: before model call ---
		// Increment model call count *before* the check so the limit is
		// evaluated against the upcoming call, not the previous one.
		guardrailState.modelCallCount++
		const preLimitEvent = checkLimits(
			guardrailState,
			limits
		)
		if (preLimitEvent) {
			emitLimitHitAndStop(preLimitEvent, ctx)
			return
		}

		// Process assistant response (with retry on transient errors)
		// With chat(): TanStack handles tool loop internally via maxIterations.
		// With streamFn: we must handle tool execution + re-call manually.
		let result = await processAgentStreamWithRetry(
			ctx,
			guardrailState
		)

		// Collect messages from this iteration
		for (const msg of result.messages) {
			newMessages.push(msg)
		}

		// --- Guardrail check: after model call (cost may have changed even on error) ---
		const postLimitEvent = checkLimits(
			guardrailState,
			limits
		)
		if (postLimitEvent) {
			emitLimitHitAndStop(postLimitEvent, ctx)
			return
		}

		// When using streamFn, handle tool execution loop manually
		if (streamFn) {
			const outcome = await runToolLoop(result, ctx)
			if (outcome.shouldReturn) return
			result = outcome.result
			if (outcome.pendingMessages.length > 0) {
				pendingMessages = outcome.pendingMessages
			}
		}

		if (result.abortedOrError) {
			handleAbortOrError(result, ctx)
			return
		}

		emit({
			type: 'turn_end',
			message: result.lastAssistant,
			toolResults: result.toolResults
		})

		// Check for steering messages after turn
		pendingMessages =
			(await config.getSteeringMessages?.()) || []
		if (pendingMessages.length > 0) continue

		// Check for follow-up messages
		const followUps =
			(await config.getFollowUpMessages?.()) || []
		if (followUps.length > 0) {
			pendingMessages = followUps
			continue
		}

		break
	}

	emit({ type: 'agent_end', messages: newMessages })
	stream.end(newMessages)
}

/**
 * Handle the abort-or-error exit path: detect wall-clock timeouts vs
 * user aborts and emit the appropriate terminal events.
 */
function handleAbortOrError(
	result: ProcessResult,
	ctx: RunContext
): void {
	const {
		guardrailState,
		signal,
		userSignal,
		config,
		emit,
		newMessages,
		stream
	} = ctx
	const limits = config.runtimeLimits
	const wallClockMs = limits?.maxWallClockMs
	const isWallClockTimeout =
		result.lastAssistant.stopReason === 'aborted' &&
		!guardrailState.limitTriggered &&
		isLimitEnabled(wallClockMs) &&
		signal?.aborted &&
		!userSignal?.aborted

	if (isWallClockTimeout) {
		const elapsed = Date.now() - guardrailState.startedAtMs
		guardrailState.limitTriggered = true
		const wallClockEvent: AgentEvent = {
			type: 'limit_hit',
			limit: 'max_wall_clock_ms',
			threshold: wallClockMs,
			observed: elapsed,
			usageSnapshot: {
				elapsedMs: elapsed,
				modelCalls: guardrailState.modelCallCount,
				costUsd: guardrailState.costUsd
			},
			scope: 'run',
			action: 'hard_stop'
		}
		emitLimitHitAndStop(wallClockEvent, ctx)
		return
	}

	emit({
		type: 'turn_end',
		message: result.lastAssistant,
		toolResults: result.toolResults
	})
	emit({ type: 'agent_end', messages: newMessages })
	stream.end(newMessages)
}
