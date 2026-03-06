/**
 * Memory integration helpers for AgentController.
 *
 * Extracted from controller.ts to keep the controller focused on
 * orchestration. Handles recall and retain (Hindsight only).
 */

import type { Agent } from '@ellie/agent'
import type {
	BlobSink,
	TraceRecorder,
	TraceScope
} from '@ellie/trace'
import {
	wrapMemoryOrchestrator,
	createChildScope
} from '@ellie/trace'
import {
	hindsightTraceStore,
	type HindsightTraceContext
} from '@ellie/hindsight'
import type { RealtimeStore } from '../../lib/realtime-store'
import type { MemoryOrchestrator } from '../memory-orchestrator'
import { handleControllerError } from './error-handler'

export interface MemoryDeps {
	store: RealtimeStore
	memory: MemoryOrchestrator | null
	agent: Agent
	baseSystemPrompt: string
	trace: (
		type: string,
		payload: Record<string, unknown>
	) => void
	/** Trace recorder for memory operation spans. */
	traceRecorder?: TraceRecorder
	/** Active trace scope for correlating memory spans. */
	traceScope?: TraceScope
	/** Blob sink for large recall/retain payloads. */
	blobSink?: BlobSink
}

/**
 * Run memory recall and inject context into the system prompt.
 * If recall fails, log the error and proceed without memory context.
 */
export async function runRecall(
	deps: MemoryDeps,
	sessionId: string,
	query: string,
	runId: string
): Promise<void> {
	if (!deps.memory) return

	// Wrap with traced facade when trace deps are available
	const memory =
		deps.traceRecorder && deps.traceScope
			? wrapMemoryOrchestrator(deps.memory, {
					recorder: deps.traceRecorder,
					parentScope: deps.traceScope,
					blobSink: deps.blobSink
				})
			: deps.memory

	try {
		const runMemoryRecall = () => memory.recall(query)
		const result =
			deps.traceRecorder && deps.traceScope
				? await hindsightTraceStore.run(
						createMemoryTraceCtx(
							deps.traceRecorder!,
							deps.traceScope!
						),
						runMemoryRecall
					)
				: await runMemoryRecall()
		if (!result) return

		if (result.contextBlock) {
			deps.agent.state.systemPrompt =
				deps.baseSystemPrompt + '\n\n' + result.contextBlock
		}
	} catch (err) {
		handleControllerError(
			deps.trace,
			`memory_recall_failed session=${sessionId} runId=${runId}`,
			'controller.memory_recall_failed',
			{ sessionId, runId },
			err,
			'warn'
		)
	}
}

/**
 * Evaluate and run memory retain after an agent run completes.
 * Stores facts in Hindsight only — does not prompt the agent.
 */
export async function runRetain(
	deps: MemoryDeps,
	sessionId: string,
	runId: string,
	force?: boolean
): Promise<number> {
	if (!deps.memory) return 0

	// Wrap with traced facade when trace deps are available
	const memory =
		deps.traceRecorder && deps.traceScope
			? wrapMemoryOrchestrator(deps.memory, {
					recorder: deps.traceRecorder,
					parentScope: deps.traceScope,
					blobSink: deps.blobSink
				})
			: deps.memory

	try {
		const runMemoryRetain = () =>
			memory.evaluateRetain(sessionId, force)
		const result =
			deps.traceRecorder && deps.traceScope
				? await hindsightTraceStore.run(
						createMemoryTraceCtx(
							deps.traceRecorder!,
							deps.traceScope!
						),
						runMemoryRetain
					)
				: await runMemoryRetain()
		if (!result) return 0

		return result.parts[0]?.factsStored ?? 0
	} catch (err) {
		handleControllerError(
			deps.trace,
			`memory_retain_failed session=${sessionId} runId=${runId}`,
			'controller.memory_retain_failed',
			{ sessionId, runId },
			err,
			'warn'
		)
		return 0
	}
}

// ── Hindsight LLM trace context ──────────────────────────────────────

/**
 * Create a HindsightTraceContext that emits memory.chat.* events
 * for every internal LLM call (extraction, consolidation, reflection, gist).
 *
 * Captures recorder and scope by value at creation time so that
 * fire-and-forget retain operations are immune to scope mutations
 * from subsequent runs.
 */
function createMemoryTraceCtx(
	recorder: TraceRecorder,
	scope: TraceScope
): HindsightTraceContext {
	const llmScopes = new Map<string, TraceScope>()
	return {
		onLLMCall: event => {
			const llmScope =
				llmScopes.get(event.callId) ??
				createChildScope(scope)
			llmScopes.set(event.callId, llmScope)
			const eventName =
				event.phase === 'start'
					? 'memory.chat.start'
					: event.phase === 'end'
						? 'memory.chat.end'
						: 'memory.chat.error'
			recorder.record(llmScope, eventName, 'memory', event)
			if (event.phase !== 'start') {
				llmScopes.delete(event.callId)
			}
		}
	}
}
