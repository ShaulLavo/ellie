import type { EventRow } from '@ellie/db'
import type { ChannelDeliveryTarget } from './types'
import type { ChannelReplyPayload } from './reply-payload'
import type { TtsAutoMode } from './auto-tts'

const UPLOAD_REF_PREFIX = 'upload:'

export const PENDING_ROW_TTL = 10 * 60_000 // 10 minutes
export const PENDING_ROW_MAX = 500
export const COMPOSING_COOLDOWN_MS = 3_000

export interface TtsConfig {
	mode: TtsAutoMode
	inboundAudio?: boolean
}

/** A single atomic send operation with stable identity for checkpointing. */
export interface OutboundItem {
	replyIndex: number
	payloadIndex: number
	attachmentIndex: number
	kind: 'message' | 'media' | 'audio_voice'
	/** Caption (media) or message text. */
	text: string
	/** Media ref to resolve and send. */
	mediaRef?: string
}

export interface PendingDelivery {
	sessionId: string
	targets: Map<string, PendingTargetDelivery>
	inFlight: Promise<void>
}

export interface PendingTargetDelivery {
	target: ChannelDeliveryTarget
	/** Checkpoint keys for items already sent (live path). */
	deliveredKeys: Set<string>
	lastComposingAt: number
}

export interface PendingRowEntry {
	sessionId: string
	target: ChannelDeliveryTarget
	createdAt: number
}

export interface ExtractedReplyPayload {
	assistantRowId: number
	payload: ChannelReplyPayload
	isLastAssistantReply: boolean
	ttsDirective?: { params?: string }
}

/** Opaque provider-native handle for an in-flight live message. */
export type LiveTextHandle = Record<string, unknown>

/** Status of a live-text stream for a single target+row. */
export type LiveTextStatus =
	| 'streaming'
	| 'finalized'
	| 'failed'

/** Per-target live state keyed by assistantRowId. */
export interface LiveTextState {
	assistantRowId: number
	handle: LiveTextHandle
	status: LiveTextStatus
	/** Last text snapshot sent to the provider. */
	lastSentText: string
	/** Serialization: promise chain for edits to this target+row. */
	editChain: Promise<void>
}

/** Durable live-delivery event payload (persisted via appendEvent). */
export interface LiveDeliveryEvent {
	channelId: string
	accountId: string
	conversationId: string
	assistantRowId: number
	handle: LiveTextHandle
	status: LiveTextStatus
	lastSentText: string
	updatedAt: number
}

export function toUploadRef(uploadId: string): string {
	return `${UPLOAD_REF_PREFIX}${uploadId}`
}

export function parseRowPayload(
	row: Pick<EventRow, 'payload'>
): Record<string, unknown> | null {
	try {
		return JSON.parse(row.payload) as Record<
			string,
			unknown
		>
	} catch {
		return null
	}
}

export function targetKey(
	t: ChannelDeliveryTarget
): string {
	return `${t.channelId}:${t.accountId}:${t.conversationId}`
}

export function checkpointKey(item: {
	replyIndex: number
	payloadIndex: number
	attachmentIndex: number
}): string {
	return `${item.replyIndex}:${item.payloadIndex}:${item.attachmentIndex}`
}

/** Split prepared payloads into individual outbound items. */
export function buildOutboundItems(
	replyIndex: number,
	preparedPayloads: ChannelReplyPayload[]
): OutboundItem[] {
	const items: OutboundItem[] = []
	for (const [
		payloadIndex,
		payload
	] of preparedPayloads.entries()) {
		if (payload.mediaRefs?.length) {
			const kind: OutboundItem['kind'] =
				payload.audioAsVoice ? 'audio_voice' : 'media'
			const caption = payload.audioAsVoice
				? ''
				: (payload.text ?? '')
			for (const [ai, ref] of payload.mediaRefs.entries()) {
				items.push({
					replyIndex,
					payloadIndex,
					attachmentIndex: ai,
					kind,
					text: ai === 0 ? caption : '',
					mediaRef: ref
				})
			}
		} else if (payload.text) {
			items.push({
				replyIndex,
				payloadIndex,
				attachmentIndex: 0,
				kind: 'message',
				text: payload.text
			})
		}
	}
	return items
}
