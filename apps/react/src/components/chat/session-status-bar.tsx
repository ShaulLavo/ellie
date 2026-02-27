import { NumberTicker } from '../ui/number-ticker'
import type { SessionStats } from '../../lib/chat/session-stats'

export type { SessionStats }

function formatModel(model: string): string {
	const match = model.match(/^claude-(.+?)(-\d{8})?$/)
	return match ? match[1] : model
}

function TokenCount({ value }: { value: number }) {
	if (value >= 1000) {
		return (
			<>
				<NumberTicker
					value={Math.round(value / 1000)}
					className="text-inherit tracking-inherit"
				/>
				k
			</>
		)
	}
	return (
		<NumberTicker
			value={value}
			className="text-inherit tracking-inherit"
		/>
	)
}

function Cost({ value }: { value: number }) {
	const decimalPlaces = value >= 0.01 ? 2 : 4
	return (
		<>
			$
			<NumberTicker
				value={value}
				decimalPlaces={decimalPlaces}
				className="text-inherit tracking-inherit"
			/>
		</>
	)
}

const DOT = (
	<span className="text-muted-foreground/50">&middot;</span>
)

export function SessionStatusBar({
	stats,
	isAgentRunning
}: {
	stats: SessionStats
	isAgentRunning: boolean
}) {
	if (stats.messageCount === 0) return null

	return (
		<div className="flex items-center justify-center gap-2 py-1.5 text-[10px] font-mono text-muted-foreground select-none tracking-wide">
			{(stats.provider || stats.model) && (
				<>
					<span>
						{stats.provider ? `${stats.provider}/` : ''}
						{stats.model ? formatModel(stats.model) : 'unknown'}
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
