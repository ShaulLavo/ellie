/**
 * Memory integration helpers for AgentController.
 *
 * Extracted from controller.ts to keep the controller focused on
 * orchestration. Handles recall, retain, and daily-write enforcement.
 */

import type { Agent } from '@ellie/agent'
import type { EventPayloadMap } from '@ellie/db'
import { ulid } from 'fast-ulid'
import type { RealtimeStore } from '../lib/realtime-store'
import type { MemoryOrchestrator } from './memory-orchestrator'

export interface MemoryDeps {
	store: RealtimeStore
	memory: MemoryOrchestrator | null
	agent: Agent
	baseSystemPrompt: string
	enforcementRunIds: Set<string>
	trace: (
		type: string,
		payload: Record<string, unknown>
	) => void
	withLock: (fn: () => Promise<void>) => Promise<void>
	getBoundSessionId: () => string | null
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
		const result = await deps.memory.recall(query)
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
		console.warn(
			`[agent-controller] memory_recall_failed session=${sessionId} runId=${runId}`,
			err instanceof Error ? err.message : String(err)
		)
		deps.trace('controller.memory_recall_failed', {
			sessionId,
			runId,
			message:
				err instanceof Error ? err.message : String(err)
		})
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
 * Does not block or affect the agent response.
 */
export async function runRetain(
	deps: MemoryDeps,
	sessionId: string,
	runId: string,
	force?: boolean
): Promise<number> {
	if (!deps.memory) return 0

	try {
		const result = await deps.memory.evaluateRetain(
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
		console.warn(
			`[agent-controller] memory_retain_failed session=${sessionId} runId=${runId}`,
			err instanceof Error ? err.message : String(err)
		)
		deps.trace('controller.memory_retain_failed', {
			sessionId,
			runId,
			message:
				err instanceof Error ? err.message : String(err)
		})
		return 0
	}
}

/**
 * Run retain and enforce daily memory write if retain found facts
 * but the agent didn't call memory_append_daily during this run.
 */
export async function runRetainAndEnforce(
	deps: MemoryDeps,
	sessionId: string,
	runId: string
): Promise<void> {
	const factsStored = await runRetain(
		deps,
		sessionId,
		runId
	)
	if (factsStored === 0) return

	// Check if the run contained a memory_append_daily call
	const runEvents = deps.store.queryRunEvents(
		sessionId,
		runId
	)

	const hadDailyWrite = runEvents.some(e => {
		if (e.type !== 'tool_execution') return false
		try {
			const parsed = JSON.parse(e.payload)
			return (
				parsed.toolName === 'memory_append_daily' &&
				parsed.status === 'complete' &&
				!parsed.isError
			)
		} catch {
			return false
		}
	})

	if (hadDailyWrite) return

	// Enforcement: trigger a silent follow-up turn
	await deps.withLock(async () => {
		if (deps.agent.state.isStreaming) return
		if (deps.getBoundSessionId() !== sessionId) return

		const enforcementRunId = ulid()
		deps.enforcementRunIds.add(enforcementRunId)
		deps.agent.runId = enforcementRunId

		deps.agent
			.prompt(
				'[SYSTEM] The retain pipeline just stored new facts from this conversation. ' +
					'You MUST call memory_append_daily now to persist any durable facts ' +
					'to daily memory. If there is nothing meaningful to persist, ' +
					'respond with exactly NO_REPLY and nothing else.'
			)
			.catch(err => {
				console.warn(
					`[agent-controller] enforcement_failed session=${sessionId} runId=${enforcementRunId}`,
					err instanceof Error ? err.message : String(err)
				)
				deps.trace('controller.enforcement_failed', {
					sessionId,
					runId: enforcementRunId,
					message:
						err instanceof Error ? err.message : String(err)
				})
			})
	})
}
