import type {
	ContentPart,
	MessageSender
} from '@ellie/schemas/chat'
import type { StoredChatMessage } from '@/chat/types'
import type { EventRow } from '@/lib/stream'

/** Parse an event payload that may be a JSON string or already-parsed object. */
export function parsePayload(
	payload: unknown
): Record<string, unknown> {
	try {
		return typeof payload === 'string'
			? (JSON.parse(payload) as Record<string, unknown>)
			: (payload as Record<string, unknown>)
	} catch {
		return {}
	}
}

/** Agent lifecycle event types */
export const AGENT_START_TYPES = new Set(['agent_start'])
export const AGENT_END_TYPES = new Set([
	'agent_end',
	'run_closed'
])

export function isAgentRunOpen(rows: EventRow[]): boolean {
	let open = false
	for (const row of rows) {
		if (AGENT_START_TYPES.has(row.type)) open = true
		if (AGENT_END_TYPES.has(row.type)) open = false
	}
	return open
}

/** Extract content parts from memory_recall / memory_retain event payloads. */
function extractMemoryParts(
	parsed: Record<string, unknown>
): ContentPart[] {
	return (parsed.parts as ContentPart[]) ?? []
}

/** Extract content parts from an error event payload. */
function extractErrorParts(
	parsed: Record<string, unknown>
): ContentPart[] {
	const errorText =
		typeof parsed.message === 'string'
			? parsed.message
			: 'An unexpected error occurred'
	return [{ type: 'text', text: errorText }]
}

/** Extract content parts from standard message event payloads. */
function extractMessageParts(
	parsed: Record<string, unknown>
): ContentPart[] {
	if (Array.isArray(parsed.content)) {
		return parsed.content as ContentPart[]
	}
	if (Array.isArray(parsed.parts)) {
		return parsed.parts as ContentPart[]
	}
	if (
		typeof parsed.content === 'string' &&
		parsed.content
	) {
		return [{ type: 'text', text: parsed.content }]
	}

	// Surface API errors: when assistant has stopReason 'error'
	// but empty content, synthesize a text part from errorMessage
	if (
		parsed.stopReason === 'error' &&
		typeof parsed.errorMessage === 'string'
	) {
		return [
			{
				type: 'text',
				text: `Error: ${parsed.errorMessage}`
			}
		]
	}

	return []
}

/** Regex to strip [[tts:...]] directives from streaming text display. */
const TTS_TAG_DISPLAY_RE = /\[\[tts(?::[^\]]*?)?\]\]/gi

/**
 * Strip [[tts:...]] from streaming display text.
 * For finalized messages, text is already clean from the server.
 */
function stripTtsForDisplay(text: string): string {
	return text.replace(TTS_TAG_DISPLAY_RE, '').trim()
}

/** Extract content parts from a tool_execution event payload (result view). */
function extractToolResultParts(
	parsed: Record<string, unknown>
): ContentPart[] {
	const resultContent = Array.isArray(parsed.content)
		? (
				parsed.content as Array<{
					type: string
					text?: string
				}>
			)
				.filter(c => c.type === 'text')
				.map(c => c.text ?? '')
				.join('')
		: ''
	return [
		{
			type: 'tool-result',
			toolName: parsed.toolName as string,
			toolCallId: parsed.toolCallId as string,
			result: resultContent,
			...(typeof parsed.elapsedMs === 'number' && {
				elapsedMs: parsed.elapsedMs
			})
		}
	]
}

/** Extract content parts from a tool_execution event payload (loading view). */
function extractToolCallParts(
	parsed: Record<string, unknown>
): ContentPart[] {
	return [
		{
			type: 'tool-call',
			name: parsed.toolName as string,
			args: (parsed.args as Record<string, unknown>) ?? {},
			toolCallId: parsed.toolCallId as string
		}
	]
}

/** Extract content parts from a generate_image tool_execution event. */
function extractImageGenParts(
	parsed: Record<string, unknown>,
	status: string
): ContentPart[] {
	const toolCallId =
		(parsed.toolCallId as string) ?? 'unknown'
	const details = (parsed.result as Record<string, unknown>)
		?.details as Record<string, unknown> | undefined
	const prompt =
		((parsed.args as Record<string, unknown> | undefined)
			?.prompt as string | undefined) ??
		(details?.prompt as string | undefined)

	if (status === 'complete' || status === 'error') {
		if (
			status === 'complete' &&
			details &&
			details.success === true
		) {
			return [
				{
					type: 'image-generation',
					toolCallId,
					status: 'complete',
					prompt,
					uploadId: details.uploadId as string | undefined,
					url: details.url as string | undefined,
					images: details.images as
						| Array<{
								uploadId: string
								url: string
								mimeType: string
								width?: number
								height?: number
								hash?: string
						  }>
						| undefined,
					entries: details.entries as
						| Array<{
								id: string
								phase: string
								label: string
								status:
									| 'started'
									| 'running'
									| 'completed'
									| 'failed'
								detail?: string
								step?: number
								totalSteps?: number
						  }>
						| undefined,
					recipe: details.recipe as
						| {
								model: string
								width: number
								height: number
								steps: number
								cfg: number
								seed: number
								durationMs: number
								loras?: Array<{
									name: string
									strength?: number
								}>
						  }
						| undefined,
					elapsedMs: details.elapsedMs as number | undefined
				}
			]
		}

		// Error or failed completion
		const errorText = details?.error
			? String(details.error)
			: status === 'error'
				? 'Image generation failed'
				: undefined
		return [
			{
				type: 'image-generation',
				toolCallId,
				status: 'error',
				prompt,
				error: errorText,
				url: details?.url as string | undefined,
				entries: details?.entries as
					| Array<{
							id: string
							phase: string
							label: string
							status:
								| 'started'
								| 'running'
								| 'completed'
								| 'failed'
							detail?: string
							step?: number
							totalSteps?: number
					  }>
					| undefined
			}
		]
	}

	// Running / in-progress
	const runDetails =
		(details as Record<string, unknown>) ?? {}
	return [
		{
			type: 'image-generation',
			toolCallId,
			status: 'running',
			prompt,
			phase: runDetails.phase as string | undefined,
			step: runDetails.step as number | undefined,
			totalSteps: runDetails.totalSteps as
				| number
				| undefined,
			detail: runDetails.detail as string | undefined,
			preview: runDetails.preview as string | undefined,
			entries: runDetails.entries as
				| Array<{
						id: string
						phase: string
						label: string
						status:
							| 'started'
							| 'running'
							| 'completed'
							| 'failed'
						detail?: string
						step?: number
						totalSteps?: number
						preview?: string
				  }>
				| undefined,
			completedPhases: runDetails.completedPhases as
				| string[]
				| undefined
		}
	]
}

/** Classify an upload ID into a media kind based on file extension. */
function classifyUploadId(
	uploadId: string
): 'image' | 'audio' | 'video' | 'file' {
	const lower = uploadId.toLowerCase()
	if (
		/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/.test(lower)
	)
		return 'image'
	if (/\.(mp3|ogg|opus|wav|m4a|flac|aac)$/.test(lower))
		return 'audio'
	if (/\.(mp4|mov|webm|avi|mkv)$/.test(lower))
		return 'video'
	return 'file'
}

/** Convert an EventRow into a StoredChatMessage (no Date allocation). */
export function eventToStored(
	row: EventRow
): StoredChatMessage {
	const parsed = parsePayload(row.payload)

	// Dispatch to the right helper based on event type
	let parts: ContentPart[]
	const isMessageStreaming = parsed.streaming === true
	if (row.type === 'assistant_message') {
		// Unified type: message is wrapped in { message, streaming }
		const msg = parsed.message as Record<string, unknown>
		parts = extractMessageParts(msg)
	} else if (row.type === 'tool_execution') {
		const status = parsed.status as string
		const toolName = parsed.toolName as string
		if (toolName === 'generate_image') {
			parts = extractImageGenParts(parsed, status)
		} else if (
			status === 'complete' ||
			status === 'error'
		) {
			parts = extractToolResultParts({
				toolName: parsed.toolName,
				toolCallId: parsed.toolCallId,
				content: (parsed.result as Record<string, unknown>)
					?.content,
				elapsedMs: parsed.elapsedMs
			})
		} else {
			parts = extractToolCallParts(parsed)
		}
	} else if (
		row.type === 'memory_recall' ||
		row.type === 'memory_retain'
	) {
		parts = extractMemoryParts(parsed)
	} else if (row.type === 'thread_created') {
		parts = [
			{
				type: 'checkpoint',
				message:
					typeof parsed.message === 'string'
						? parsed.message
						: 'New thread started'
			}
		]
	} else if (row.type === 'error') {
		parts = extractErrorParts(parsed)
	} else if (row.type === 'assistant_artifact') {
		// Artifact bound to a reply → render as assistant-artifact content part
		const uploadId = parsed.uploadId as string | undefined
		if (uploadId) {
			const kind = parsed.kind as 'media' | 'audio' | 'file'
			const origin = parsed.origin as
				| 'tool_upload'
				| 'tts'
				| 'llm_directive'
			parts = [
				{
					type: 'assistant-artifact',
					kind,
					origin,
					uploadId,
					url:
						(parsed.url as string) ??
						`/api/uploads-rpc/${encodeURIComponent(uploadId)}/content`,
					mimeType: parsed.mimeType as string | undefined,
					mediaKind:
						kind === 'audio'
							? 'audio'
							: classifyUploadId(uploadId),
					...(typeof parsed.width === 'number' && {
						width: parsed.width
					}),
					...(typeof parsed.height === 'number' && {
						height: parsed.height
					}),
					...(typeof parsed.hash === 'string' && {
						hash: parsed.hash
					})
				}
			]
		} else {
			parts = []
		}
	} else {
		parts = extractMessageParts(parsed)
	}

	let text = parts
		.filter(
			(p): p is Extract<ContentPart, { type: 'text' }> =>
				p.type === 'text'
		)
		.map(p => p.text)
		.join('\n')

	const thinking =
		parts
			.filter(
				(
					p
				): p is Extract<
					ContentPart,
					{ type: 'thinking' }
				> => p.type === 'thinking'
			)
			.map(p => p.text)
			.join('\n') || undefined

	// Filter out non-renderable blocks:
	// - thinking: extracted above for separate display
	// - toolCall: agent-internal camelCase format, already rendered via tool_execution events
	//   EXCEPT during streaming, where we surface them as tool-call parts with streaming flag
	let filteredParts: ContentPart[] = []
	for (const p of parts) {
		if (p.type === 'thinking') continue
		const raw = p as Record<string, unknown>
		if (raw.type === 'toolCall') {
			if (isMessageStreaming) {
				filteredParts.push({
					type: 'tool-call',
					name: raw.name as string,
					args:
						(raw.arguments as Record<string, unknown>) ??
						{},
					toolCallId: raw.id as string | undefined,
					streaming: true
				})
			}
			continue
		}
		filteredParts.push(p)
	}

	// Strip empty text parts from finalized (non-streaming) messages.
	if (!isMessageStreaming) {
		filteredParts = filteredParts.filter(
			p => p.type !== 'text' || p.text.trim().length > 0
		)
	}

	// For streaming messages only, strip [[tts:...]] from display text.
	// For finalized messages, text is already clean from the server.
	if (isMessageStreaming) {
		filteredParts = filteredParts.map(p => {
			if (p.type !== 'text') return p
			const cleaned = stripTtsForDisplay(p.text)
			return cleaned.length > 0
				? { ...p, text: cleaned }
				: p
		})
		filteredParts = filteredParts.filter(
			p => p.type !== 'text' || p.text.trim().length > 0
		)
	}

	// Recompute text from processed parts
	text = filteredParts
		.filter(
			(p): p is Extract<ContentPart, { type: 'text' }> =>
				p.type === 'text'
		)
		.map(p => p.text)
		.join('\n')

	// Determine sender from event type or payload
	let sender: MessageSender | undefined
	if (
		row.type === 'user_message' ||
		parsed.role === 'user'
	) {
		sender = 'user'
	} else if (
		row.type === 'assistant_message' ||
		row.type === 'assistant_artifact' ||
		parsed.role === 'assistant'
	) {
		sender = 'agent'
	} else if (parsed.role === 'system') {
		sender = 'system'
	} else if (row.type === 'thread_created') {
		sender = 'system'
	} else if (row.type === 'error') {
		sender = 'agent'
	} else if (row.type.startsWith('tool_')) {
		sender = 'agent'
	} else if (row.type.startsWith('memory_')) {
		sender = 'memory'
	}

	// Extract parent message ID for nesting (tools → assistant reply, artifacts → assistant reply)
	let parentMessageId: string | undefined
	if (row.type === 'tool_execution') {
		const srcId = parsed.sourceAssistantRowId as
			| number
			| undefined
		if (srcId != null) parentMessageId = String(srcId)
	} else if (row.type === 'assistant_artifact') {
		const parentId = parsed.assistantRowId as
			| number
			| undefined
		if (parentId != null) parentMessageId = String(parentId)
	}

	return {
		id: String(row.id),
		timestamp: new Date(row.createdAt).toISOString(),
		text,
		parts: filteredParts,
		seq: row.seq,
		sender,
		thinking,
		runId: row.runId,
		eventType: row.type,
		parentMessageId
	}
}
