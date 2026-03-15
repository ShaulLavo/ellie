import { useChatMessages } from './use-chat-messages'
import { useChatBranchStats } from './use-chat-branch-stats'
import { useStreamConnection } from './use-stream-connection'

export function useChatDB(branchId: string) {
	const { messages, upsert, replaceAll, clear } =
		useChatMessages(branchId)
	const { branchStats, setBranchStats, clearBranchStats } =
		useChatBranchStats(branchId)

	const resetBranchState = () => {
		clear()
		clearBranchStats()
	}

	const stream = useStreamConnection({
		branchId,
		upsert,
		replaceAll,
		resetBranchState,
		setBranchStats
	})

	return {
		messages,
		streamingMessage: stream.streamingMessage,
		connectionState: stream.connectionState,
		error: stream.error,
		branchStats,
		isAgentRunning: stream.isAgentRunning,
		sendMessage: stream.sendMessage,
		clearBranch: stream.clearBranch,
		retry: stream.retry
	}
}
