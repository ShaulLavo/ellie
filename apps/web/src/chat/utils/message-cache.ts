import type { StoredChatMessage } from '@/chat/types'

function compareBySeq(
	a: StoredChatMessage,
	b: StoredChatMessage
): number {
	return a.seq - b.seq
}

function haveSameParts(
	a: StoredChatMessage,
	b: StoredChatMessage
): boolean {
	return JSON.stringify(a.parts) === JSON.stringify(b.parts)
}

function areMessagesEqual(
	a: StoredChatMessage,
	b: StoredChatMessage
): boolean {
	return (
		a.id === b.id &&
		a.timestamp === b.timestamp &&
		a.text === b.text &&
		a.seq === b.seq &&
		a.sender === b.sender &&
		a.isStreaming === b.isStreaming &&
		a.streamGroupId === b.streamGroupId &&
		a.thinking === b.thinking &&
		a.runId === b.runId &&
		a.eventType === b.eventType &&
		a.parentMessageId === b.parentMessageId &&
		haveSameParts(a, b)
	)
}

function reuseMessage(
	prevById: Map<string, StoredChatMessage>,
	message: StoredChatMessage
): StoredChatMessage {
	const prev = prevById.get(message.id)
	if (!prev) return message
	return areMessagesEqual(prev, message) ? prev : message
}

function hasSameOrderedRefs(
	prev: StoredChatMessage[],
	next: StoredChatMessage[]
): boolean {
	if (prev.length !== next.length) return false

	for (let i = 0; i < prev.length; i++) {
		if (prev[i] !== next[i]) return false
	}

	return true
}

export function replaceMessages(
	prev: StoredChatMessage[] | undefined,
	next: StoredChatMessage[]
): StoredChatMessage[] {
	const prevMessages = prev ?? []
	const prevById = new Map(
		prevMessages.map(
			message => [message.id, message] as const
		)
	)
	const orderedNext = [...next]
		.sort(compareBySeq)
		.map(message => reuseMessage(prevById, message))

	if (hasSameOrderedRefs(prevMessages, orderedNext)) {
		return prevMessages
	}

	return orderedNext
}

export function upsertMessages(
	prev: StoredChatMessage[] | undefined,
	incoming: StoredChatMessage[]
): StoredChatMessage[] {
	const prevMessages = prev ?? []
	const mergedById = new Map(
		prevMessages.map(
			message => [message.id, message] as const
		)
	)

	for (const message of incoming) {
		const prevMessage = mergedById.get(message.id)
		mergedById.set(
			message.id,
			prevMessage && areMessagesEqual(prevMessage, message)
				? prevMessage
				: message
		)
	}

	const orderedNext = [...mergedById.values()].sort(
		compareBySeq
	)
	if (hasSameOrderedRefs(prevMessages, orderedNext)) {
		return prevMessages
	}

	return orderedNext
}
