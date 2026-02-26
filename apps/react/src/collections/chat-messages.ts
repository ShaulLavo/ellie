import { createCollection } from '@tanstack/react-db'
import type {
	ContentPart,
	ChatMessage,
	MessageSender
} from '@ellie/schemas/chat'

/**
 * Serialize-safe variant of ChatMessage.
 * `timestamp` is stored as ISO string — Date objects don't survive JSON round-trips.
 */
export interface StoredChatMessage {
	id: string
	timestamp: string
	text: string
	parts: ContentPart[]
	seq: number
	sender?: MessageSender
	isStreaming?: boolean
	streamGroupId?: string
	thinking?: string
}

export function toStored(
	msg: ChatMessage
): StoredChatMessage {
	return {
		...msg,
		timestamp: msg.timestamp.toISOString(),
		seq: msg.line
	}
}

export function fromStored(
	stored: StoredChatMessage
): ChatMessage {
	return {
		...stored,
		timestamp: new Date(stored.timestamp),
		line: stored.seq
	}
}

/**
 * Sync handle captured from TanStack DB's `sync` config callback.
 * Calling begin -> write -> commit pushes data directly into the
 * collection's reactive internals, triggering useLiveQuery updates.
 */
export interface CollectionSyncHandle {
	begin: () => void
	write: (
		msg: StoredChatMessage,
		type: 'insert' | 'update' | 'delete'
	) => void
	commit: () => void
	truncate: () => void
}

function createSyncedCollection(sessionId: string) {
	let syncHandle: CollectionSyncHandle | null = null

	const collection = createCollection<
		StoredChatMessage,
		string
	>({
		id: `chat-messages:${sessionId}`,
		getKey: item => item.id,
		startSync: true,
		sync: {
			sync: ({
				begin,
				write,
				commit,
				markReady,
				truncate
			}) => {
				syncHandle = {
					begin,
					write: (msg, type) => write({ value: msg, type }),
					commit,
					truncate
				}
				// Mark ready immediately — our SSE stream manages the lifecycle
				markReady()
				return () => {
					syncHandle = null
				}
			}
		}
	})

	if (!syncHandle) {
		throw new Error(
			'sync callback was not invoked synchronously'
		)
	}

	return {
		collection,
		syncHandle: syncHandle as CollectionSyncHandle
	}
}

type ChatCollection = ReturnType<
	typeof createSyncedCollection
>['collection']

interface ChatCollectionEntry {
	collection: ChatCollection
	sync: CollectionSyncHandle
}

const collectionsMap = new Map<
	string,
	ChatCollectionEntry
>()

export function getChatMessagesCollection(
	sessionId: string
) {
	let entry = collectionsMap.get(sessionId)
	if (!entry) {
		const { collection, syncHandle } =
			createSyncedCollection(sessionId)
		entry = { collection, sync: syncHandle }
		collectionsMap.set(sessionId, entry)
	}
	return entry.collection
}

export function getChatMessagesSyncHandle(
	sessionId: string
): CollectionSyncHandle {
	getChatMessagesCollection(sessionId) // ensure exists
	return collectionsMap.get(sessionId)!.sync
}

/**
 * Destroy and remove a collection.
 * Used on session/branch switch to fully reset.
 */
export function destroyChatMessagesCollection(
	sessionId: string
) {
	const entry = collectionsMap.get(sessionId)
	if (entry) {
		entry.collection.cleanup()
	}
	collectionsMap.delete(sessionId)
}
