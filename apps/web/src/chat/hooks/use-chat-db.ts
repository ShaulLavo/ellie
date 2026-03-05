import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useState } from 'react'
import {
	getChatMessagesCollection,
	type StoredChatMessage
} from '@/collections/chat-messages'
import { useChatSync } from './use-chat-sync'
import { useStreamConnection } from './use-stream-connection'

export function useChatDB(sessionId: string) {
	const [sessionVersion, setSessionVersion] = useState(0)

	const { syncWrite, syncReplaceAll, destroyCollection } =
		useChatSync(sessionId)

	// ── Live query: reactive sorted messages ───────────────────────────
	const { data: storedMessages } = useLiveQuery(
		q =>
			q
				.from({
					msg: getChatMessagesCollection(sessionId)
				})
				.orderBy(
					({ msg }) =>
						(msg as unknown as StoredChatMessage).seq,
					'asc'
				),
		[sessionId, sessionVersion]
	)

	const messages = (storedMessages ??
		[]) as StoredChatMessage[]

	const resetSessionState = useCallback(() => {
		destroyCollection()
		setSessionVersion(v => v + 1)
	}, [destroyCollection])

	const stream = useStreamConnection(
		sessionId,
		syncWrite,
		syncReplaceAll,
		resetSessionState
	)

	return {
		messages,
		streamingMessage: stream.streamingMessage,
		connectionState: stream.connectionState,
		error: stream.error,
		sessionStats: stream.sessionStats,
		isAgentRunning: stream.isAgentRunning,
		sendMessage: stream.sendMessage,
		clearSession: stream.clearSession,
		retry: stream.retry
	}
}
