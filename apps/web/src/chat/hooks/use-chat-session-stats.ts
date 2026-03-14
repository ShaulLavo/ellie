import {
	useQuery,
	useQueryClient
} from '@tanstack/react-query'
import {
	EMPTY_STATS,
	type SessionStats
} from '@/lib/chat/session-stats'

type SessionStatsUpdater =
	| SessionStats
	| ((prev: SessionStats) => SessionStats)

export function useChatSessionStats(sessionId: string) {
	const queryClient = useQueryClient()
	const queryKey = [
		'chat-session-stats',
		sessionId
	] as const

	const { data: sessionStats = EMPTY_STATS } = useQuery({
		queryKey,
		queryFn: async () => EMPTY_STATS,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY
	})

	const setSessionStats = (
		updater: SessionStatsUpdater
	) => {
		queryClient.setQueryData(
			queryKey,
			(prev: SessionStats | undefined) => {
				const current = prev ?? EMPTY_STATS
				return typeof updater === 'function'
					? updater(current)
					: updater
			}
		)
	}

	const clearSessionStats = () => {
		queryClient.setQueryData(queryKey, EMPTY_STATS)
	}

	return {
		sessionStats,
		setSessionStats,
		clearSessionStats
	}
}
