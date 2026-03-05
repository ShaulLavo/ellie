/**
 * Unified streaming persistence for assistant_message and tool_execution.
 *
 * Each streaming entity gets a single DB row: INSERT on start, UPDATE on
 * delta/completion. This module owns the row-ID tracking maps and the
 * event → DB write logic.
 */

import type { AgentEvent } from '@ellie/agent'
import type { AssistantMessage } from '@ellie/schemas'
import type { RealtimeStore } from '../lib/realtime-store'
import { handleControllerError } from './controller-error-handler'

export interface StreamPersistenceDeps {
	store: RealtimeStore
	trace: (
		type: string,
		payload: Record<string, unknown>
	) => void
}

/**
 * Mutable state for in-flight streaming rows.
 * Owned by the controller, passed into handler functions.
 */
export interface StreamState {
	/** Row ID of the in-flight assistant_message being streamed */
	currentMessageRowId: number | null
	/** Map of toolCallId → row ID for in-flight tool_execution rows */
	currentToolRowIds: Map<string, number>
}

export function createStreamState(): StreamState {
	return {
		currentMessageRowId: null,
		currentToolRowIds: new Map()
	}
}

export function resetStreamState(state: StreamState): void {
	state.currentMessageRowId = null
	state.currentToolRowIds.clear()
}

/**
 * Handle a streaming AgentEvent by persisting to the DB.
 * Returns true if the event was handled, false if it should
 * fall through to the non-streaming mapper.
 */
export function handleStreamingEvent(
	deps: StreamPersistenceDeps,
	state: StreamState,
	event: AgentEvent,
	sessionId: string,
	runId: string
): boolean {
	if (event.type === 'message_start') {
		if (event.message.role !== 'assistant') return true
		try {
			const row = deps.store.appendEvent(
				sessionId,
				'assistant_message',
				{
					message: event.message as AssistantMessage,
					streaming: true
				},
				runId
			)
			state.currentMessageRowId = row.id
		} catch (err) {
			handleControllerError(
				deps.trace,
				`persist_failed type=assistant_message session=${sessionId} runId=${runId}`,
				'controller.persist_failed',
				{ sessionId, runId, dbType: 'assistant_message' },
				err
			)
		}
		return true
	}

	if (event.type === 'message_update') {
		if (event.message.role !== 'assistant') return true
		if (!state.currentMessageRowId) return true
		try {
			deps.store.updateEvent(
				state.currentMessageRowId,
				{
					message: event.message as AssistantMessage,
					streaming: true
				},
				sessionId
			)
		} catch (err) {
			handleControllerError(
				deps.trace,
				`update_failed type=assistant_message (delta) session=${sessionId} runId=${runId}`,
				'controller.update_failed',
				{ sessionId, runId, dbType: 'assistant_message' },
				err,
				'warn'
			)
		}
		return true
	}

	if (event.type === 'message_end') {
		if (event.message.role !== 'assistant') return true
		if (!state.currentMessageRowId) return true
		try {
			deps.store.updateEvent(
				state.currentMessageRowId,
				{
					message: event.message as AssistantMessage,
					streaming: false
				},
				sessionId
			)
		} catch (err) {
			handleControllerError(
				deps.trace,
				`update_failed type=assistant_message (final) session=${sessionId} runId=${runId}`,
				'controller.update_failed',
				{ sessionId, runId, dbType: 'assistant_message' },
				err
			)
		}
		state.currentMessageRowId = null
		return true
	}

	if (event.type === 'tool_execution_start') {
		try {
			const row = deps.store.appendEvent(
				sessionId,
				'tool_execution',
				{
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					status: 'running' as const
				},
				runId
			)
			state.currentToolRowIds.set(event.toolCallId, row.id)
		} catch (err) {
			handleControllerError(
				deps.trace,
				`persist_failed type=tool_execution session=${sessionId} runId=${runId}`,
				'controller.persist_failed',
				{ sessionId, runId, dbType: 'tool_execution' },
				err
			)
		}
		return true
	}

	if (event.type === 'tool_execution_update') {
		const rowId = state.currentToolRowIds.get(
			event.toolCallId
		)
		if (!rowId) return true
		try {
			deps.store.updateEvent(
				rowId,
				{
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					result: event.partialResult,
					status: 'running' as const
				},
				sessionId
			)
		} catch (err) {
			handleControllerError(
				deps.trace,
				`update_failed type=tool_execution (delta) session=${sessionId} runId=${runId}`,
				'controller.update_failed',
				{ sessionId, runId, dbType: 'tool_execution' },
				err,
				'warn'
			)
		}
		return true
	}

	if (event.type === 'tool_execution_end') {
		const rowId = state.currentToolRowIds.get(
			event.toolCallId
		)
		if (!rowId) return true
		try {
			deps.store.updateEvent(
				rowId,
				{
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
					status: event.isError
						? ('error' as const)
						: ('complete' as const)
				},
				sessionId
			)
		} catch (err) {
			handleControllerError(
				deps.trace,
				`update_failed type=tool_execution (final) session=${sessionId} runId=${runId}`,
				'controller.update_failed',
				{ sessionId, runId, dbType: 'tool_execution' },
				err
			)
		}
		state.currentToolRowIds.delete(event.toolCallId)
		return true
	}

	return false
}
