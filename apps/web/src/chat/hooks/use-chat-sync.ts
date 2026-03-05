import { useCallback } from 'react'
import {
	destroyChatMessagesCollection,
	getChatMessagesCollection,
	getChatMessagesSyncHandle,
	type StoredChatMessage
} from '@/collections/chat-messages'

export function useChatSync(sessionId: string) {
	const syncWrite = useCallback(
		(msgs: StoredChatMessage[]) => {
			const sync = getChatMessagesSyncHandle(sessionId)
			const collection =
				getChatMessagesCollection(sessionId)
			sync.begin()
			for (const msg of msgs) {
				sync.write(
					msg,
					collection.has(msg.id) ? 'update' : 'insert'
				)
			}
			sync.commit()
		},
		[sessionId]
	)

	const syncReplaceAll = useCallback(
		(msgs: StoredChatMessage[]) => {
			const sync = getChatMessagesSyncHandle(sessionId)
			sync.begin()
			sync.truncate()
			for (const msg of msgs) {
				sync.write(msg, 'insert')
			}
			sync.commit()
		},
		[sessionId]
	)

	const destroyCollection = useCallback(() => {
		destroyChatMessagesCollection(sessionId)
	}, [sessionId])

	return { syncWrite, syncReplaceAll, destroyCollection }
}
