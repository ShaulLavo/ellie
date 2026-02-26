/**
 * Shared chat types — used by both server and frontend.
 *
 * These types define the contract between the event store (server) and
 * the FE reducers that project raw events into renderable messages.
 */

// ── Content parts ────────────────────────────────────────────────────────────

export type ContentPart =
	| { type: 'text'; text: string }
	| {
			type: 'image'
			file: string
			mime: string
			size: number
			thumb?: string
			width?: number
			height?: number
	  }
	| {
			type: 'video'
			file: string
			mime: string
			size: number
			thumb?: string
			duration?: number
	  }
	| {
			type: 'audio'
			file: string
			mime: string
			size: number
			waveform?: string
			duration?: number
	  }
	| {
			type: 'file'
			file: string
			mime: string
			size: number
			name?: string
	  }
	| {
			type: 'tool-call'
			name: string
			args: Record<string, unknown>
			toolCallId?: string
	  }
	| {
			type: 'tool-result'
			result: string
			toolCallId?: string
			toolName?: string
	  }
	| {
			type: 'memory'
			text: string
			count: number
			memories?: Array<{ text: string; model?: string }>
			duration_ms?: number
	  }
	| {
			type: 'memory-retain'
			factsStored: number
			facts: string[]
			model?: string
			duration_ms?: number
	  }
	| { type: 'thinking'; text: string }
	| {
			type: 'artifact'
			artifactType: ArtifactType
			content: string
			filename: string
			title?: string
	  }

export type ArtifactType =
	| 'html'
	| 'svg'
	| 'markdown'
	| 'json'
	| 'pdf'
	| 'docx'
	| 'xlsx'
	| 'pptx'
	| 'code'
	| 'image'

// ── Log entry (server → client wire format) ──────────────────────────────────

export type MessageSender =
	| 'user'
	| 'agent'
	| 'system'
	| 'memory'
	| 'human'

export interface LogEntry {
	id: string
	ts: number
	type: string
	payload: { parts: ContentPart[] }
	meta?: Record<string, unknown> | null
	line: number
	parentId?: string | null
}

// ── Chat message (client-side projection) ────────────────────────────────────

export interface ChatMessage {
	id: string
	timestamp: Date
	text: string
	parts: ContentPart[]
	line: number
	parentId?: string | null
	sender?: MessageSender
	isStreaming?: boolean
	streamGroupId?: string
	thinking?: string
}

export type ConnectionState =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'error'

export interface SessionInfo {
	model: string
	agentName: string
	contextTokens: number
	contextWindow: number
	messageCount: number
	usage?: {
		promptTokens: number
		completionTokens: number
		totalTokens: number
	}
	cost?: number
}

export interface ProgressInfo {
	taskId: string
	taskType: 'image-gen' | 'setup' | 'download'
	label: string
	step?: number
	totalSteps?: number
	percent?: number
	node?: string
	status: 'started' | 'running' | 'completed' | 'failed'
	detail?: string
}

// ── Projection helpers ───────────────────────────────────────────────────────

/** Convert a LogEntry from the server into a client-side ChatMessage. */
export function toMessage(entry: LogEntry): ChatMessage {
	const { parts } = entry.payload
	const text = parts
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

	const filteredParts = thinking
		? parts.filter(p => p.type !== 'thinking')
		: parts

	return {
		id: entry.id,
		timestamp: new Date(entry.ts),
		text,
		parts: filteredParts,
		line: entry.line,
		parentId: entry.parentId ?? null,
		sender:
			(entry.meta?.sender as MessageSender) ?? undefined,
		streamGroupId:
			(entry.meta?.streamGroupId as string) ?? undefined,
		thinking
	}
}

// ── Transcript ───────────────────────────────────────────────────────────────

export interface TranscriptEntry {
	id: string
	timestamp: string
	role: 'user' | 'assistant' | 'system' | 'memory'
	type: string
	content: string
	meta?: Record<string, unknown> | null
}

export interface Transcript {
	generatedAt: string
	entryCount: number
	entries: TranscriptEntry[]
}

function resolveRoleFromSender(
	sender?: MessageSender
): TranscriptEntry['role'] {
	if (sender === 'human' || sender === 'user') return 'user'
	if (sender === 'agent') return 'assistant'
	if (sender === 'memory') return 'memory'
	if (sender === 'system') return 'system'
	return 'user'
}

function formatPart(part: ContentPart): string {
	switch (part.type) {
		case 'text':
			return part.text
		case 'thinking':
			return `<thinking>\n${part.text}\n</thinking>`
		case 'tool-call':
			return `[Tool Call: ${part.name}]\n${formatArgs(part.args)}`
		case 'tool-result':
			return `[Tool Result${part.toolName ? `: ${part.toolName}` : ''}]\n${part.result}`
		case 'memory':
			return `[Memory Recall]\n${
				part.memories
					?.map(m => `  - ${m.text}`)
					.join('\n') ?? part.text
			}`
		case 'memory-retain':
			return `[Memory Retain - ${part.factsStored} facts]\n${part.facts.map(f => `  - ${f}`).join('\n')}`
		case 'image':
			return `[Image: ${part.file}]`
		case 'video':
			return `[Video: ${part.file}]`
		case 'audio':
			return `[Audio: ${part.file}]`
		case 'file':
			return `[File: ${part.name ?? part.file}]`
		case 'artifact':
			return `[Artifact: ${part.title ?? part.filename}]\n${part.content}`
		default:
			return `[Unknown: ${(part as ContentPart).type}]`
	}
}

function formatArgs(args: Record<string, unknown>): string {
	return Object.entries(args)
		.map(
			([k, val]) =>
				`  ${k}: ${typeof val === 'string' ? val : JSON.stringify(val)}`
		)
		.join('\n')
}

export function messagesToTranscript(
	messages: ChatMessage[]
): Transcript {
	const entries: TranscriptEntry[] = []

	for (const msg of messages) {
		const role = resolveRoleFromSender(msg.sender)
		const partContent = msg.parts.map(formatPart).join('\n')
		const thinkingContent = msg.thinking
			? `<thinking>\n${msg.thinking}\n</thinking>`
			: ''
		const content = [thinkingContent, partContent]
			.filter(Boolean)
			.join('\n')

		const partTypes = new Set(msg.parts.map(p => p.type))
		let type = 'text'
		if (partTypes.size === 1) {
			type = [...partTypes][0]
		} else if (partTypes.size > 1) {
			type = 'mixed'
		}

		entries.push({
			id: msg.id,
			timestamp: msg.timestamp.toISOString(),
			role,
			type,
			content: content || msg.text
		})
	}

	return {
		generatedAt: new Date().toISOString(),
		entryCount: entries.length,
		entries
	}
}

export function renderTranscript(
	transcript: Transcript
): string {
	const lines: string[] = []
	lines.push(
		`Transcript - ${transcript.entryCount} entries`
	)
	lines.push(`Generated: ${transcript.generatedAt}`)
	lines.push('='.repeat(60))

	for (const entry of transcript.entries) {
		const label =
			entry.role === 'user'
				? 'User'
				: entry.role === 'assistant'
					? 'Assistant'
					: entry.role === 'memory'
						? 'Memory'
						: 'System'
		lines.push('')
		lines.push(
			`[${entry.timestamp}] ${label} (${entry.type})`
		)
		lines.push('-'.repeat(60))
		lines.push(entry.content)
	}

	lines.push('')
	lines.push('='.repeat(60))
	lines.push('End of transcript')
	return lines.join('\n')
}
