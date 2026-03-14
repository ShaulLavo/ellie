/**
 * Unified streaming persistence for assistant_message and tool_execution.
 *
 * Each streaming entity gets a single DB row: INSERT on start, UPDATE on
 * delta/completion. This module owns the row-ID tracking maps and the
 * event → DB write logic.
 *
 * Reply-centric pipeline: tool uploads are tracked as pending artifacts
 * and emitted as assistant_artifact events at message_end, rather than
 * injecting MEDIA: directives into assistant message text.
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

export interface PendingArtifact {
	uploadId: string
	kind: 'media' | 'file'
	origin: 'tool_upload'
	mime?: string
	width?: number
	height?: number
	hash?: string
}

/**
 * Mutable state for in-flight streaming rows.
 * Owned by the controller, passed into handler functions.
 */
interface ToolRowEntry {
	rowId: number
	sourceAssistantRowId: number | undefined
}

export interface StreamState {
	/** Row ID of the in-flight assistant_message being streamed */
	currentMessageRowId: number | null
	/** Row ID of the last finalized assistant_message (survives message_end) */
	lastFinalizedMessageRowId: number | null
	/** Map of toolCallId → row info for in-flight tool_execution rows */
	currentToolRowIds: Map<string, ToolRowEntry>
	/** Pending artifacts from completed tool executions in this run */
	pendingArtifacts: PendingArtifact[]
}

export function createStreamState(): StreamState {
	return {
		currentMessageRowId: null,
		lastFinalizedMessageRowId: null,
		currentToolRowIds: new Map(),
		pendingArtifacts: []
	}
}

export function resetStreamState(state: StreamState): void {
	state.currentMessageRowId = null
	state.lastFinalizedMessageRowId = null
	state.currentToolRowIds.clear()
	state.pendingArtifacts.length = 0
}

/** TTS directive regex: captures optional params after the colon */
const TTS_DIRECTIVE_RE = /\[\[tts(?::([^\]]*))?\]\]/gi

/** MEDIA: line regex (outside code fences) */
const MEDIA_LINE_RE = /^\s*MEDIA:\s*.+$/i

/**
 * Strip [[tts:...]] directives from text, returning cleaned text and
 * the captured params (if any).
 */
function stripTtsDirective(text: string): {
	cleaned: string
	params: string | undefined
} {
	let params: string | undefined
	const cleaned = text.replace(
		TTS_DIRECTIVE_RE,
		(_match, p1) => {
			if (p1 !== undefined) params = p1
			return ''
		}
	)
	return { cleaned: cleaned.trim(), params }
}

/**
 * Strip MEDIA: lines from text (outside code fences).
 * These are legacy LLM-written directives that should not appear in clean output.
 */
function stripMediaLines(text: string): string {
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

		if (MEDIA_LINE_RE.test(line)) {
			continue
		}

		output.push(line)
	}

	return output.join('\n')
}

/**
 * Normalize an assistant message: clone and clean content blocks.
 * Strips thinking blocks etc. Does NOT inject MEDIA lines.
 */
function normalizeAssistantMessage(
	message: AssistantMessage
): AssistantMessage {
	return {
		...message,
		content: message.content.map(part => {
			if (part.type !== 'text') return part
			return { ...part }
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
 * Flush pending artifacts as assistant_artifact events targeting the
 * last finalized assistant message row.
 */
export function flushPendingArtifacts(
	deps: StreamPersistenceDeps,
	state: StreamState,
	sessionId: string,
	runId: string
): void {
	if (state.pendingArtifacts.length === 0) return
	const targetRowId = state.lastFinalizedMessageRowId
	if (!targetRowId) return
	for (const artifact of state.pendingArtifacts) {
		deps.store.appendEvent(
			sessionId,
			'assistant_artifact',
			{
				assistantRowId: targetRowId,
				kind: artifact.kind,
				origin: artifact.origin,
				uploadId: artifact.uploadId,
				mime: artifact.mime,
				...(artifact.width != null && {
					width: artifact.width
				}),
				...(artifact.height != null && {
					height: artifact.height
				}),
				...(artifact.hash && { hash: artifact.hash })
			},
			runId
		)
	}
	state.pendingArtifacts.length = 0
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
				const message = normalizeAssistantMessage(
					event.message as AssistantMessage
				)
				const row = deps.store.appendEvent(
					sessionId,
					'assistant_message',
					{
						message,
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
				let message = normalizeAssistantMessage(
					event.message as AssistantMessage
				)

				// 1. Strip [[tts:...]] directives from text parts
				let ttsDirective: { params: string } | undefined
				message = {
					...message,
					content: message.content.map(part => {
						if (part.type !== 'text') return part
						const { cleaned, params } = stripTtsDirective(
							part.text
						)
						if (params !== undefined) {
							ttsDirective = { params }
						}
						return { ...part, text: cleaned }
					})
				}

				// 2. Strip MEDIA: lines from text (legacy LLM behavior)
				message = {
					...message,
					content: message.content.map(part => {
						if (part.type !== 'text') return part
						return {
							...part,
							text: stripMediaLines(part.text)
						}
					})
				}

				// 3. Store CLEAN text in the assistant_message row
				deps.store.updateEvent(
					state.currentMessageRowId!,
					{
						message,
						streaming: false,
						...(ttsDirective && { ttsDirective })
					},
					sessionId
				)

				// 4. Set lastFinalizedMessageRowId before clearing current
				state.lastFinalizedMessageRowId =
					state.currentMessageRowId

				// 5. Emit assistant_artifact events for pending artifacts
				if (state.pendingArtifacts.length > 0) {
					console.log(
						`[stream-persist] message_end: emitting ${state.pendingArtifacts.length} artifact event(s)`
					)
					flushPendingArtifacts(
						deps,
						state,
						sessionId,
						runId
					)
				} else {
					console.log(
						'[stream-persist] message_end: no pending artifacts'
					)
				}
			}
		)
		// 6. Clear currentMessageRowId (lastFinalizedMessageRowId survives)
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
				const srcId =
					state.lastFinalizedMessageRowId ?? undefined
				const row = deps.store.appendEvent(
					sessionId,
					'tool_execution',
					{
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						status: 'running' as const,
						sourceAssistantRowId: srcId
					},
					runId
				)
				state.currentToolRowIds.set(event.toolCallId, {
					rowId: row.id,
					sourceAssistantRowId: srcId
				})
			}
		)
		return true
	}

	if (event.type === 'tool_execution_update') {
		const entry = state.currentToolRowIds.get(
			event.toolCallId
		)
		if (!entry) return true
		persistSafe(
			deps,
			sessionId,
			runId,
			'tool_execution (delta)',
			'update_failed',
			() => {
				deps.store.updateEvent(
					entry.rowId,
					{
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						result: event.partialResult,
						status: 'running' as const,
						sourceAssistantRowId: entry.sourceAssistantRowId
					},
					sessionId
				)
			},
			'warn'
		)
		return true
	}

	if (event.type === 'tool_execution_end') {
		const entry = state.currentToolRowIds.get(
			event.toolCallId
		)
		if (entry) {
			persistSafe(
				deps,
				sessionId,
				runId,
				'tool_execution (final)',
				'update_failed',
				() => {
					deps.store.updateEvent(
						entry.rowId,
						{
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							result: event.result,
							isError: event.isError,
							status: event.isError
								? ('error' as const)
								: ('complete' as const),
							elapsedMs: event.elapsedMs,
							sourceAssistantRowId:
								entry.sourceAssistantRowId
						},
						sessionId
					)
				}
			)
			state.currentToolRowIds.delete(event.toolCallId)
		}

		// Track successful tool uploads as pending artifacts
		if (!event.isError) {
			const details = (
				event.result as {
					details?: {
						success?: boolean
						uploadId?: string
						images?: Array<{
							uploadId: string
							mime?: string
							width?: number
							height?: number
							hash?: string
						}>
						recipe?: {
							width?: number
							height?: number
						}
					}
				}
			)?.details
			console.log(
				`[stream-persist] tool_execution_end: toolName=${event.toolName} success=${details?.success} uploadId=${details?.uploadId} images=${details?.images?.length ?? 0}`
			)
			if (details?.success) {
				if (details.images && details.images.length > 0) {
					for (const img of details.images) {
						state.pendingArtifacts.push({
							uploadId: img.uploadId,
							kind: 'media',
							origin: 'tool_upload',
							mime: img.mime,
							width: img.width ?? details.recipe?.width,
							height: img.height ?? details.recipe?.height,
							hash: img.hash
						})
					}
				} else if (details.uploadId) {
					state.pendingArtifacts.push({
						uploadId: details.uploadId,
						kind: 'media',
						origin: 'tool_upload',
						width: details.recipe?.width,
						height: details.recipe?.height
					})
				}
			}
		}

		return true
	}

	return false
}
