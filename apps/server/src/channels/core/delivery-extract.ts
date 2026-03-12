import type { RealtimeStore } from '../../lib/realtime-store'
import type { ChannelReplyPayload } from './reply-payload'
import { buildReplyPayload } from './reply-payload'
import {
	appendUniqueMediaRef,
	extractToolUploadRefs,
	normalizeMediaRef,
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
	const extracted: Array<{
		assistantRowId: number
		payload: ChannelReplyPayload
	}> = []
	const pendingAutoMedia: string[] = []
	const pendingSeen = new Set<string>()

	for (const row of rows) {
		if (row.type === 'tool_execution') {
			const parsed = parseRowPayload(row)
			if (!parsed) continue
			const result = parsed.result as
				| Record<string, unknown>
				| undefined
			const details = result?.details as
				| Record<string, unknown>
				| undefined
			for (const ref of extractToolUploadRefs(details)) {
				appendUniqueMediaRef(
					pendingAutoMedia,
					pendingSeen,
					ref
				)
			}
			continue
		}

		if (row.type !== 'assistant_message') continue

		const parsed = parseRowPayload(row)
		if (!parsed) continue
		if (parsed.streaming) continue

		const rawText = extractAssistantMessageText(parsed)
		const payload = rawText
			? buildReplyPayload(rawText)
			: {
					text: undefined,
					mediaRefs: undefined,
					audioAsVoice: undefined
				}
		const mediaRefs: string[] = []
		const seen = new Set<string>()
		for (const ref of pendingAutoMedia) {
			appendUniqueMediaRef(mediaRefs, seen, ref)
		}
		for (const ref of payload.mediaRefs ?? []) {
			appendUniqueMediaRef(mediaRefs, seen, ref)
		}
		pendingAutoMedia.length = 0
		pendingSeen.clear()

		const replyPayload: ChannelReplyPayload = {
			text: payload.text,
			mediaRefs:
				mediaRefs.length > 0 ? mediaRefs : undefined,
			audioAsVoice: payload.audioAsVoice
		}
		if (!replyPayload.text && !replyPayload.mediaRefs) {
			continue
		}
		extracted.push({
			assistantRowId: row.id,
			payload: replyPayload
		})
	}

	if (pendingAutoMedia.length > 0) {
		if (extracted.length === 0) {
			extracted.push({
				assistantRowId: 0,
				payload: {
					mediaRefs: [...pendingAutoMedia]
				}
			})
		} else {
			const last = extracted.at(-1)!
			const mediaRefs = [...(last.payload.mediaRefs ?? [])]
			const seen = new Set(mediaRefs.map(normalizeMediaRef))
			for (const ref of pendingAutoMedia) {
				appendUniqueMediaRef(mediaRefs, seen, ref)
			}
			last.payload.mediaRefs = mediaRefs
		}
	}

	return extracted.map((entry, index) => ({
		assistantRowId: entry.assistantRowId,
		payload: entry.payload,
		isLastAssistantReply: index === extracted.length - 1
	}))
}

export function extractAssistantMessageText(
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
