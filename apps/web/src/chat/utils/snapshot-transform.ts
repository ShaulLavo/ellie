import type { StoredChatMessage } from '@/chat/types'
import type { EventRow } from '@/lib/stream'
import { eventToStored } from '../event-transforms'
import {
	getClosedRunIds,
	shouldRenderInSnapshot,
	isStreamingAssistantEvent,
	finalizeStreamingMessage,
	isRenderableMessage
} from './stream-event-handlers'

/**
 * Transform raw EventRow[] into finalized StoredChatMessage[].
 * Shared by both REST bootstrap and SSE snapshot so they produce identical output.
 */
export function snapshotToMessages(
	events: EventRow[]
): StoredChatMessage[] {
	let lastRotatedIdx = -1
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === 'thread_created') {
			lastRotatedIdx = events[i].seq
			break
		}
	}
	const closedRunIds = getClosedRunIds(events)

	return events
		.filter(event =>
			shouldRenderInSnapshot(
				event,
				lastRotatedIdx,
				closedRunIds
			)
		)
		.map(event => {
			const message = eventToStored(event)
			if (!isStreamingAssistantEvent(event)) {
				return message
			}
			return finalizeStreamingMessage(message)
		})
		.filter(
			(message): message is StoredChatMessage =>
				message != null && isRenderableMessage(message)
		)
}
