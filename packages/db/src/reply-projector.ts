import type { EventRow } from './schema'

export interface NormalizedArtifact {
	kind: 'media' | 'audio' | 'file'
	origin: 'tool_upload' | 'tts' | 'llm_directive'
	uploadId: string
	url?: string
	mimeType?: string
}

export interface NormalizedReply {
	assistantRowId: number
	text: string
	thinking?: string
	artifacts: NormalizedArtifact[]
	ttsDirective?: { params?: string }
	streaming: boolean
	runId: string | null
	seq: number
	createdAt: number
}

function parsePayload(raw: string | unknown): unknown {
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw)
		} catch {
			return raw
		}
	}
	return raw
}

/**
 * Walk event rows and produce normalized reply data.
 * Used by both the delivery pipeline and the web frontend.
 */
export function projectReplies(
	rows: EventRow[]
): NormalizedReply[] {
	const repliesByRowId = new Map<number, NormalizedReply>()
	const ordered: NormalizedReply[] = []

	for (const row of rows) {
		if (row.type === 'assistant_message') {
			const payload = parsePayload(row.payload) as {
				message?: {
					content?: Array<{
						type: string
						text?: string
					}>
				}
				streaming?: boolean
				ttsDirective?: { params?: string }
			}

			const streaming = payload.streaming ?? false
			if (streaming) continue // skip in-flight messages

			const content = payload.message?.content ?? []

			let text = ''
			let thinking: string | undefined

			for (const block of content) {
				if (block.type === 'text' && block.text) {
					text += (text ? '\n' : '') + block.text
				} else if (
					block.type === 'thinking' &&
					block.text
				) {
					thinking =
						(thinking ? thinking + '\n' : '') + block.text
				}
			}

			const reply: NormalizedReply = {
				assistantRowId: row.id,
				text,
				thinking,
				artifacts: [],
				ttsDirective: payload.ttsDirective,
				streaming: false,
				runId: row.runId,
				seq: row.seq,
				createdAt: row.createdAt
			}

			repliesByRowId.set(row.id, reply)
			ordered.push(reply)
		} else if (row.type === 'assistant_artifact') {
			const payload = parsePayload(row.payload) as {
				assistantRowId?: number
				kind?: string
				origin?: string
				uploadId?: string
				url?: string
				mimeType?: string
			}

			const targetId = payload.assistantRowId
			if (targetId == null) continue

			const reply = repliesByRowId.get(targetId)
			if (!reply) continue

			reply.artifacts.push({
				kind: payload.kind as NormalizedArtifact['kind'],
				origin:
					payload.origin as NormalizedArtifact['origin'],
				uploadId: payload.uploadId ?? '',
				url: payload.url,
				mimeType: payload.mimeType
			})
		}
	}

	return ordered
}
