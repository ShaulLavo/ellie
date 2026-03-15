import type { RealtimeStore } from '../../lib/realtime-store'
import { projectReplies } from '@ellie/db'
import {
	toUploadRef,
	parseRowPayload,
	type ExtractedReplyPayload
} from './delivery-helpers'
import * as path from 'node:path'

/** Build ordered reply payloads from completed assistant messages in a run. */
export function extractReplyPayloads(
	store: RealtimeStore,
	sessionId: string,
	runId: string
): ExtractedReplyPayload[] {
	const rows = store.queryRunEvents(sessionId, runId)
	const replies = projectReplies(rows)
	return replies.map((reply, i) => ({
		assistantRowId: reply.assistantRowId,
		payload: {
			text: reply.text || undefined,
			mediaRefs: reply.artifacts
				.filter(a => a.kind !== 'audio')
				.map(a => toUploadRef(a.uploadId)),
			audioAsVoice:
				reply.artifacts.some(a => a.kind === 'audio') ||
				undefined
		},
		isLastAssistantReply: i === replies.length - 1,
		ttsDirective: reply.ttsDirective
	}))
}

function extractAssistantMessageText(
	payload: Record<string, unknown>
): string | null {
	const message = payload.message as
		| {
				content?: Array<{
					type: string
					text?: string
				}>
		  }
		| undefined
	if (!message?.content) return null
	const texts: string[] = []
	for (const block of message.content) {
		if (block.type === 'text' && block.text) {
			texts.push(block.text)
		}
	}
	if (texts.length === 0) return null
	return texts.join('\n')
}

export function resolveMediaRef(
	ref: string,
	dataDir: string | undefined
): string {
	const trimmed = ref.trim()
	const uploadPrefixMatch = trimmed.match(/^upload:(.+)$/i)
	const uploadId = uploadPrefixMatch?.[1]
	if (!uploadId) return ref
	if (!dataDir) {
		throw new Error(
			'Cannot resolve upload media without dataDir'
		)
	}
	return path.join(dataDir, 'uploads', uploadId)
}

export function mediaLocalRoots(
	dataDir: string | undefined
): string[] {
	const roots: string[] = []
	if (dataDir) {
		roots.push(path.join(dataDir, 'uploads'))
	}
	// os.tmpdir() for TTS temp files
	roots.push(require('node:os').tmpdir())
	return roots
}

interface StreamingRowSnapshot {
	assistantRowId: number
	text: string
	streaming: boolean
	ttsDirective?: { params?: string }
}

/**
 * Extract the current streaming assistant message row for a run.
 * Returns null if no assistant_message row is currently streaming or
 * if the row is not eligible for live text (e.g. has pending tool uploads).
 */
export function extractStreamingRow(
	store: RealtimeStore,
	sessionId: string,
	runId: string
): StreamingRowSnapshot | null {
	const rows = store.queryRunEvents(sessionId, runId)

	// Walk backwards to find the latest assistant_message row
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i]!
		if (row.type !== 'assistant_message') continue

		const parsed = parseRowPayload(row)
		if (!parsed) return null

		const text = extractAssistantMessageText(parsed)
		if (!text) return null

		return {
			assistantRowId: row.id,
			text,
			streaming: parsed.streaming === true,
			ttsDirective: parsed.ttsDirective as
				| { params?: string }
				| undefined
		}
	}

	return null
}

/**
 * Check if a row is eligible for live text streaming.
 * Ineligible if the row has TTS directives, or MEDIA directives.
 */
export function isLiveTextEligible(
	snapshot: StreamingRowSnapshot
): boolean {
	// Has TTS directive — defer to finalized path
	if (snapshot.ttsDirective) return false
	// Has MEDIA directive — will become media delivery
	if (/^\s*media:\s/im.test(snapshot.text)) return false
	return true
}
