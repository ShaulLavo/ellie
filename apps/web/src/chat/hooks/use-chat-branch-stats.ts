import {
	useQuery,
	useQueryClient
} from '@tanstack/react-query'
import {
	EMPTY_STATS,
	type BranchStats
} from '@/lib/chat/branch-stats'

type BranchStatsUpdater =
	| BranchStats
	| ((prev: BranchStats) => BranchStats)

export function useChatBranchStats(branchId: string) {
	const queryClient = useQueryClient()
	const queryKey = ['chat-branch-stats', branchId] as const

	const { data: branchStats = EMPTY_STATS } = useQuery({
		queryKey,
		queryFn: async () => EMPTY_STATS,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY
	})

	const setBranchStats = (updater: BranchStatsUpdater) => {
		queryClient.setQueryData(
			queryKey,
			(prev: BranchStats | undefined) => {
				const current = prev ?? EMPTY_STATS
				return typeof updater === 'function'
					? updater(current)
					: updater
			}
		)
	}

	const clearBranchStats = () => {
		queryClient.setQueryData(queryKey, EMPTY_STATS)
	}

	return {
		branchStats,
		setBranchStats,
		clearBranchStats
	}
}
