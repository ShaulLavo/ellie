/**
 * Memory integration helpers for AgentController.
 *
 * Extracted from controller.ts to keep the controller focused on
 * orchestration. Handles recall and retain (Hindsight only).
 */

import type { Agent } from '@ellie/agent'
import type { EventPayloadMap } from '@ellie/db'
import type {
	TraceRecorder,
	TraceScope
} from '@ellie/trace'
import { wrapMemoryOrchestrator } from '@ellie/trace'
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
					parentScope: deps.traceScope
				})
			: deps.memory

	try {
		const result = await memory.recall(query)
		if (!result) return

		deps.store.appendEvent(
			sessionId,
			'memory_recall',
			result.payload as EventPayloadMap['memory_recall'],
			runId
		)

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
		try {
			deps.store.appendEvent(
				sessionId,
				'error',
				{
					message: `Memory recall failed: ${err instanceof Error ? err.message : String(err)}`,
					code: 'memory_recall_failed'
				},
				runId
			)
		} catch {
			// Best-effort error event
		}
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
					parentScope: deps.traceScope
				})
			: deps.memory

	try {
		const result = await memory.evaluateRetain(
			sessionId,
			force
		)
		if (!result) return 0

		deps.store.appendEvent(
			sessionId,
			'memory_retain',
			result as EventPayloadMap['memory_retain'],
			runId
		)

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
