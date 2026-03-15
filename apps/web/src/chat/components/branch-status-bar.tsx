import { NumberTicker } from '@/components/ui/number-ticker'
import type { BranchStats } from '@/lib/chat/branch-stats'
import { TokenCount } from './token-count'
import { Cost } from './cost-display'
import { formatModel } from '../utils'

export type { BranchStats }

const DOT = (
	<span className="text-muted-foreground/50">&middot;</span>
)

export function BranchStatusBar({
	stats,
	isAgentRunning
}: {
	stats: BranchStats
	isAgentRunning: boolean
}) {
	if (stats.messageCount === 0) return null

	return (
		<div className="flex items-center justify-center gap-2 py-1.5 text-[10px] font-mono text-muted-foreground select-none tracking-wide">
			{(stats.provider || stats.model) && (
				<>
					<span>
						{stats.provider ? `${stats.provider}/` : ''}
						{stats.model
							? formatModel(stats.model)
							: 'unknown'}
					</span>
					{DOT}
				</>
			)}
			<span title="prompt tokens">
				&uarr;
				<TokenCount value={stats.promptTokens} />
			</span>
			<span title="completion tokens">
				&darr;
				<TokenCount value={stats.completionTokens} />
			</span>
			{stats.totalCost > 0 && (
				<>
					{DOT}
					<Cost value={stats.totalCost} />
				</>
			)}
			{DOT}
			<span>
				<NumberTicker
					value={stats.messageCount}
					className="text-inherit tracking-inherit"
				/>{' '}
				msgs
			</span>
			{isAgentRunning && (
				<>
					{DOT}
					<span className="text-foreground">thinking</span>
				</>
			)}
		</div>
	)
}
