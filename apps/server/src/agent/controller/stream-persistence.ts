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
	mimeType?: string
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

interface ToolUploadImage {
	uploadId: string
	mimeType?: string
	width?: number
	height?: number
	hash?: string
}

interface ToolUploadDetails {
	success: boolean
	uploadId?: string
	images?: ToolUploadImage[]
	recipe?: { width?: number; height?: number }
}

/**
 * Safely extract upload details from a tool execution result.
 * Returns undefined if the shape doesn't match expectations.
 */
function parseToolUploadDetails(
	result: unknown
): ToolUploadDetails | undefined {
	if (
		result == null ||
		typeof result !== 'object' ||
		!('details' in result)
	)
		return undefined

	const details = (result as Record<string, unknown>)
		.details
	if (
		details == null ||
		typeof details !== 'object' ||
		!('success' in details)
	)
		return undefined

	const d = details as Record<string, unknown>
	if (typeof d.success !== 'boolean' || !d.success)
		return undefined

	const parsed: ToolUploadDetails = { success: true }

	if (typeof d.uploadId === 'string')
		parsed.uploadId = d.uploadId

	if (d.recipe != null && typeof d.recipe === 'object') {
		const r = d.recipe as Record<string, unknown>
		parsed.recipe = {
			...(typeof r.width === 'number' && {
				width: r.width
			}),
			...(typeof r.height === 'number' && {
				height: r.height
			})
		}
	}

	if (Array.isArray(d.images)) {
		const images: ToolUploadImage[] = []
		for (const item of d.images) {
			if (
				item != null &&
				typeof item === 'object' &&
				'uploadId' in item &&
				typeof (item as Record<string, unknown>)
					.uploadId === 'string'
			) {
				const i = item as Record<string, unknown>
				images.push({
					uploadId: i.uploadId as string,
					...(typeof i.mimeType === 'string' && {
						mimeType: i.mimeType
					}),
					...(typeof i.width === 'number' && {
						width: i.width
					}),
					...(typeof i.height === 'number' && {
						height: i.height
					}),
					...(typeof i.hash === 'string' && {
						hash: i.hash
					})
				})
			}
		}
		if (images.length > 0) parsed.images = images
	}

	return parsed
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
	matched: boolean
	params: string | undefined
} {
	let matched = false
	let params: string | undefined
	const cleaned = text.replace(
		TTS_DIRECTIVE_RE,
		(_match, p1) => {
			matched = true
			if (p1 !== undefined) params = p1
			return ''
		}
	)
	return { cleaned: cleaned.trim(), matched, params }
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
				mimeType: artifact.mimeType,
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
				const raw = normalizeAssistantMessage(
					event.message as AssistantMessage
				)

				// Strip [[tts:...]] directives and MEDIA: lines in a single pass
				let ttsDirective:
					| { params: string | undefined }
					| undefined
				const message = {
					...raw,
					content: raw.content.map(part => {
						if (part.type !== 'text') return part
						const { cleaned, matched, params } =
							stripTtsDirective(part.text)
						if (matched) {
							ttsDirective = { params }
						}
						return {
							...part,
							text: stripMediaLines(cleaned)
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
					flushPendingArtifacts(
						deps,
						state,
						sessionId,
						runId
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
			const details = parseToolUploadDetails(event.result)
			if (details) {
				if (details.images && details.images.length > 0) {
					for (const img of details.images) {
						state.pendingArtifacts.push({
							uploadId: img.uploadId,
							kind: 'media',
							origin: 'tool_upload',
							mimeType: img.mimeType,
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
