/**
 * Unified streaming persistence for assistant_message and tool_execution.
 *
 * Each streaming entity gets a single DB row: INSERT on start, UPDATE on
 * delta/completion. This module owns the row-ID tracking maps and the
 * event → DB write logic.
 */

import type { AgentEvent } from '@ellie/agent'
import type { AssistantMessage } from '@ellie/schemas'
import type { RealtimeStore } from '../../lib/realtime-store'
import { handleControllerError } from './error-handler'

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

function toUploadContentUrl(uploadId: string): string {
	return `/api/uploads-rpc/${encodeURIComponent(uploadId)}/content`
}

function normalizeMediaDirectiveText(text: string): string {
	const lines = text.split('\n')
	const output: string[] = []
	let inFence = false

	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence
			output.push(line)
			continue
		}

		if (inFence) {
			output.push(line)
			continue
		}

		const mediaMatch = line.match(/^(\s*MEDIA:\s*)(.+)$/i)
		if (!mediaMatch) {
			output.push(line)
			continue
		}

		const [, prefix, rawRef] = mediaMatch
		const ref = rawRef.trim()
		const uploadMatch = ref.match(/^upload:(.+)$/i)
		if (!uploadMatch?.[1]) {
			output.push(line)
			continue
		}

		output.push(
			`${prefix}${toUploadContentUrl(uploadMatch[1])}`
		)
	}

	return output.join('\n')
}

function normalizeAssistantMessage(
	message: AssistantMessage
): AssistantMessage {
	return {
		...message,
		content: message.content.map(part => {
			if (part.type !== 'text') return part
			return {
				...part,
				text: normalizeMediaDirectiveText(part.text)
			}
		})
	}
}

/** Persist a DB write with standardized error handling. */
function persistSafe(
	deps: StreamPersistenceDeps,
	sessionId: string,
	runId: string,
	label: string,
	errorType: 'persist_failed' | 'update_failed',
	fn: () => void,
	severity?: 'warn'
): void {
	try {
		fn()
	} catch (err) {
		handleControllerError(
			deps.trace,
			`${errorType} type=${label} session=${sessionId} runId=${runId}`,
			`controller.${errorType}`,
			{ sessionId, runId, dbType: label.split(' ')[0]! },
			err,
			severity
		)
	}
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
		persistSafe(
			deps,
			sessionId,
			runId,
			'assistant_message',
			'persist_failed',
			() => {
				const row = deps.store.appendEvent(
					sessionId,
					'assistant_message',
					{
						message: normalizeAssistantMessage(
							event.message as AssistantMessage
						),
						streaming: true
					},
					runId
				)
				state.currentMessageRowId = row.id
			}
		)
		return true
	}

	if (event.type === 'message_update') {
		if (event.message.role !== 'assistant') return true
		if (!state.currentMessageRowId) return true
		persistSafe(
			deps,
			sessionId,
			runId,
			'assistant_message (delta)',
			'update_failed',
			() => {
				deps.store.updateEvent(
					state.currentMessageRowId!,
					{
						message: normalizeAssistantMessage(
							event.message as AssistantMessage
						),
						streaming: true
					},
					sessionId
				)
			},
			'warn'
		)
		return true
	}

	if (event.type === 'message_end') {
		if (event.message.role !== 'assistant') return true
		if (!state.currentMessageRowId) return true
		persistSafe(
			deps,
			sessionId,
			runId,
			'assistant_message (final)',
			'update_failed',
			() => {
				deps.store.updateEvent(
					state.currentMessageRowId!,
					{
						message: normalizeAssistantMessage(
							event.message as AssistantMessage
						),
						streaming: false
					},
					sessionId
				)
			}
		)
		state.currentMessageRowId = null
		return true
	}

	if (event.type === 'tool_execution_start') {
		persistSafe(
			deps,
			sessionId,
			runId,
			'tool_execution',
			'persist_failed',
			() => {
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
				state.currentToolRowIds.set(
					event.toolCallId,
					row.id
				)
			}
		)
		return true
	}

	if (event.type === 'tool_execution_update') {
		const rowId = state.currentToolRowIds.get(
			event.toolCallId
		)
		if (!rowId) return true
		persistSafe(
			deps,
			sessionId,
			runId,
			'tool_execution (delta)',
			'update_failed',
			() => {
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
			},
			'warn'
		)
		return true
	}

	if (event.type === 'tool_execution_end') {
		const rowId = state.currentToolRowIds.get(
			event.toolCallId
		)
		if (!rowId) return true
		persistSafe(
			deps,
			sessionId,
			runId,
			'tool_execution (final)',
			'update_failed',
			() => {
				deps.store.updateEvent(
					rowId,
					{
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result,
						isError: event.isError,
						status: event.isError
							? ('error' as const)
							: ('complete' as const),
						elapsedMs: event.elapsedMs
					},
					sessionId
				)
			}
		)
		state.currentToolRowIds.delete(event.toolCallId)
		return true
	}

	return false
}
