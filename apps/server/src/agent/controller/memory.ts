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
	/** Active trace scope for correlating memory spans.
	 *  Getter avoids stale references when scope changes per-run. */
	getTraceScope: () => TraceScope | undefined
	/** Blob sink for large recall/retain payloads. */
	blobSink?: BlobSink
}

/**
 * Run a memory operation with optional tracing.
 * Wraps the orchestrator with a traced facade and runs the
 * operation inside the hindsight trace store when trace deps are available.
 */
async function withTracedMemory<T>(
	deps: MemoryDeps,
	fn: (memory: MemoryOrchestrator) => Promise<T>
): Promise<T> {
	const traceScope = deps.getTraceScope()
	const memory =
		deps.traceRecorder && traceScope
			? wrapMemoryOrchestrator(deps.memory!, {
					recorder: deps.traceRecorder,
					parentScope: traceScope,
					blobSink: deps.blobSink
				})
			: deps.memory!

	const run = () => fn(memory)
	return deps.traceRecorder && traceScope
		? hindsightTraceStore.run(
				createMemoryTraceCtx(
					deps.traceRecorder!,
					traceScope
				),
				run
			)
		: run()
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

	try {
		const result = await withTracedMemory(deps, m =>
			m.recall(query)
		)
		if (!result) return

		if (result.contextBlock) {
			deps.agent.state.systemPrompt =
				deps.baseSystemPrompt + '\n\n' + result.contextBlock
		}

		// Emit memory_recall event so the client can show recall status
		deps.store.appendEvent(
			sessionId,
			'memory_recall',
			result.payload,
			runId
		)
	} catch (err) {
		handleControllerError(
			deps.trace,
			`memory_recall_failed session=${sessionId} runId=${runId}`,
			'controller.memory_recall_failed',
			{ sessionId, runId },
			err
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

	try {
		const result = await withTracedMemory(deps, m =>
			m.evaluateRetain(sessionId, force)
		)
		if (!result) return 0

		// Emit memory_retain event so the client can show retain status
		deps.store.appendEvent(
			sessionId,
			'memory_retain',
			result,
			runId
		)

		return result.parts[0]?.factsStored ?? 0
	} catch (err) {
		handleControllerError(
			deps.trace,
			`memory_retain_failed session=${sessionId} runId=${runId}`,
			'controller.memory_retain_failed',
			{ sessionId, runId },
			err
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
