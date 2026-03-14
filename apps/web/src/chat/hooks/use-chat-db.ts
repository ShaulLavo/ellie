import { useChatMessages } from './use-chat-messages'
import { useChatSessionStats } from './use-chat-session-stats'
import { useStreamConnection } from './use-stream-connection'

export function useChatDB(sessionId: string) {
	const { messages, upsert, replaceAll, clear } =
		useChatMessages(sessionId)
	const {
		sessionStats,
		setSessionStats,
		clearSessionStats
	} = useChatSessionStats(sessionId)

	const resetSessionState = () => {
		clear()
		clearSessionStats()
	}

	const stream = useStreamConnection(
		sessionId,
		upsert,
		replaceAll,
		resetSessionState,
		setSessionStats
	)

	return {
		messages,
		streamingMessage: stream.streamingMessage,
		connectionState: stream.connectionState,
		error: stream.error,
		sessionStats,
		isAgentRunning: stream.isAgentRunning,
		sendMessage: stream.sendMessage,
		clearSession: stream.clearSession,
		retry: stream.retry
	}
}
