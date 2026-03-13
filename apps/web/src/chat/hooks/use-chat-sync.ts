import {
	destroyChatMessagesCollection,
	getChatMessagesCollection,
	getChatMessagesSyncHandle,
	type StoredChatMessage
} from '@/collections/chat-messages'

export function useChatSync(sessionId: string) {
	const syncWrite = (msgs: StoredChatMessage[]) => {
		const sync = getChatMessagesSyncHandle(sessionId)
		const collection = getChatMessagesCollection(sessionId)
		sync.begin()
		for (const msg of msgs) {
			sync.write(
				msg,
				collection.has(msg.id) ? 'update' : 'insert'
			)
		}
		sync.commit()
	}

	const syncReplaceAll = (msgs: StoredChatMessage[]) => {
		const sync = getChatMessagesSyncHandle(sessionId)
		sync.begin()
		sync.truncate()
		for (const msg of msgs) {
			sync.write(msg, 'insert')
		}
		sync.commit()
	}

	const destroyCollection = () => {
		destroyChatMessagesCollection(sessionId)
	}

	return { syncWrite, syncReplaceAll, destroyCollection }
}
