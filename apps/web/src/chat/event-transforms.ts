import type {
	ContentPart,
	MessageSender
} from '@ellie/schemas/chat'
import type { StoredChatMessage } from '@/collections/chat-messages'
import type { EventRow } from '@/lib/stream'

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

function classifyMediaRef(
	ref: string
): Extract<
	ContentPart,
	{ type: 'media-directive' }
>['mediaKind'] {
	const lower = ref.toLowerCase()

	// Upload content URLs ending in image extensions (e.g. .png)
	// The path may contain /content suffix after the extension
	const pathWithoutQuery = lower.split('?')[0] ?? lower
	const pathToCheck = pathWithoutQuery.endsWith('/content')
		? pathWithoutQuery.slice(0, -'/content'.length)
		: pathWithoutQuery

	if (
		pathToCheck.endsWith('.png') ||
		pathToCheck.endsWith('.jpg') ||
		pathToCheck.endsWith('.jpeg') ||
		pathToCheck.endsWith('.gif') ||
		pathToCheck.endsWith('.webp') ||
		pathToCheck.endsWith('.svg')
	) {
		return 'image'
	}
	if (
		pathToCheck.endsWith('.mp3') ||
		pathToCheck.endsWith('.ogg') ||
		pathToCheck.endsWith('.opus') ||
		pathToCheck.endsWith('.wav') ||
		pathToCheck.endsWith('.m4a')
	) {
		return 'audio'
	}
	if (
		pathToCheck.endsWith('.mp4') ||
		pathToCheck.endsWith('.mov') ||
		pathToCheck.endsWith('.webm')
	) {
		return 'video'
	}
	return 'file'
}

function extractUploadIdFromMediaRef(
	ref: string
): string | undefined {
	const trimmed = ref.trim()
	const uploadPrefixMatch = trimmed.match(/^upload:(.+)$/i)
	if (uploadPrefixMatch?.[1]) {
		return uploadPrefixMatch[1]
	}

	const uploadContentMatch = trimmed.match(
		/\/api\/uploads-rpc\/([^/?#]+)\/content(?:[?#].*)?$/i
	)
	if (uploadContentMatch?.[1]) {
		try {
			return decodeURIComponent(uploadContentMatch[1])
		} catch {
			return uploadContentMatch[1]
		}
	}

	const marker = '/uploads/'
	const markerIndex = trimmed.indexOf(marker)
	if (markerIndex === -1) return undefined
	const uploadId = trimmed.slice(
		markerIndex + marker.length
	)
	return uploadId.length > 0 ? uploadId : undefined
}

function extractRenderableMediaUrl(
	ref: string
): string | undefined {
	const trimmed = ref.trim()
	if (/^https?:\/\//i.test(trimmed)) return trimmed
	if (
		/^\/api\/uploads-rpc\/.+\/content(?:[?#].*)?$/i.test(
			trimmed
		)
	) {
		return trimmed
	}
	return undefined
}

function parseDisplayDirectives(text: string): {
	text: string
	mediaParts: Extract<
		ContentPart,
		{ type: 'media-directive' }
	>[]
} {
	const lines = text.split('\n')
	const output: string[] = []
	const mediaParts: Extract<
		ContentPart,
		{ type: 'media-directive' }
	>[] = []
	let inFence = false

	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence
			output.push(line)
			continue
		}

		if (!inFence) {
			if (/^\s*MEDIA:\s*/i.test(line)) {
				const ref = line
					.replace(/^\s*MEDIA:\s*/i, '')
					.trim()
				if (ref.length > 0) {
					const uploadId = extractUploadIdFromMediaRef(ref)
					mediaParts.push({
						type: 'media-directive',
						ref,
						uploadId,
						url: extractRenderableMediaUrl(ref),
						mediaKind: classifyMediaRef(ref)
					})
				}
				continue
			}
			const cleaned = line
				.replace(/\[\[tts(?::[^\]]*?)?\]\]/gi, '')
				.trim()
			if (cleaned.length === 0 && line.trim().length > 0)
				continue
			output.push(cleaned)
			continue
		}

		output.push(line)
	}

	const collapsed: string[] = []
	let previousBlank = false
	for (const line of output) {
		const isBlank = line.trim().length === 0
		if (isBlank && previousBlank) continue
		collapsed.push(line)
		previousBlank = isBlank
	}

	return {
		text: collapsed.join('\n').trim(),
		mediaParts
	}
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
					uploadId: details.uploadId as string | undefined,
					url: details.url as string | undefined,
					images: details.images as
						| Array<{
								uploadId: string
								url: string
								mime: string
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
			phase: runDetails.phase as string | undefined,
			step: runDetails.step as number | undefined,
			totalSteps: runDetails.totalSteps as
				| number
				| undefined,
			detail: runDetails.detail as string | undefined,
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
				  }>
				| undefined,
			completedPhases: runDetails.completedPhases as
				| string[]
				| undefined
		}
	]
}

/** Convert an EventRow into a StoredChatMessage (no Date allocation). */
export function eventToStored(
	row: EventRow
): StoredChatMessage {
	let parsed: Record<string, unknown>
	try {
		parsed =
			typeof row.payload === 'string'
				? (JSON.parse(row.payload) as Record<
						string,
						unknown
					>)
				: (row.payload as Record<string, unknown>)
	} catch {
		parsed = {}
	}

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
	} else if (row.type === 'session_rotated') {
		parts = [
			{
				type: 'checkpoint',
				message:
					typeof parsed.message === 'string'
						? parsed.message
						: 'New day, new session'
			}
		]
	} else if (row.type === 'error') {
		parts = extractErrorParts(parsed)
	} else if (row.type === 'assistant_audio') {
		// TTS post-processor synthesized audio → render as voice message
		const uploadId = parsed.uploadId as string | undefined
		if (uploadId) {
			parts = [
				{
					type: 'audio',
					file: uploadId,
					url: parsed.url as string | undefined,
					mime: (parsed.mime as string) ?? 'audio/ogg',
					size: (parsed.size as number) ?? 0
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
	// When toolCall blocks are filtered out, empty text blocks may remain
	// and create ghost message bubbles in the UI.
	if (!isMessageStreaming) {
		filteredParts = filteredParts.filter(
			p => p.type !== 'text' || p.text.trim().length > 0
		)
	}

	// Strip [[tts]] / [[tts:...]] directives from displayed text
	const displayParts: ContentPart[] = []
	for (const p of filteredParts) {
		if (p.type === 'text') {
			const parsedText = parseDisplayDirectives(p.text)
			if (parsedText.text.trim().length > 0) {
				displayParts.push({
					...p,
					text: parsedText.text
				})
			}
			displayParts.push(...parsedText.mediaParts)
			continue
		}
		displayParts.push(p)
	}

	filteredParts = displayParts.filter(
		p => p.type !== 'text' || p.text.trim().length > 0
	)

	// Recompute text from display-processed parts (e.g. [[tts]] suppresses all text)
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
		row.type === 'assistant_audio' ||
		parsed.role === 'assistant'
	) {
		sender = 'agent'
	} else if (parsed.role === 'system') {
		sender = 'system'
	} else if (row.type === 'session_rotated') {
		sender = 'system'
	} else if (row.type === 'error') {
		sender = 'agent'
	} else if (row.type.startsWith('tool_')) {
		sender = 'agent'
	} else if (row.type.startsWith('memory_')) {
		sender = 'memory'
	}

	return {
		id: String(row.id),
		timestamp: new Date(row.createdAt).toISOString(),
		text,
		parts: filteredParts,
		seq: row.seq,
		sender,
		thinking,
		runId: row.runId
	}
}

/**
 * Merge assistant_audio messages into their parent assistant_message
 * so audio + transcript render as a single message (like user voice messages).
 *
 * An assistant_audio message is an agent message whose parts are all audio
 * and that shares a runId with a preceding assistant_message.
 */
export function mergeAssistantAudio(
	msgs: StoredChatMessage[]
): StoredChatMessage[] {
	const result: StoredChatMessage[] = []
	for (const msg of msgs) {
		const isAudioOnly =
			msg.sender === 'agent' &&
			msg.runId &&
			msg.parts.length > 0 &&
			msg.parts.every(p => p.type === 'audio')

		if (isAudioOnly) {
			// Find the last assistant message with the same runId
			let merged = false
			for (let i = result.length - 1; i >= 0; i--) {
				if (
					result[i].sender === 'agent' &&
					result[i].runId === msg.runId
				) {
					result[i] = {
						...result[i],
						parts: [...result[i].parts, ...msg.parts]
					}
					merged = true
					break
				}
			}
			if (!merged) result.push(msg)
			continue
		}
		result.push(msg)
	}
	return result
}
