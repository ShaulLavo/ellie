import type { BranchStats } from '@/lib/chat/branch-stats'

import {
	Context,
	ContextCacheUsage,
	ContextContent,
	ContextContentBody,
	ContextContentFooter,
	ContextContentHeader,
	ContextInputUsage,
	ContextOutputUsage,
	ContextReasoningUsage,
	ContextTrigger
} from '@/components/ai-elements/context'
import { getContextWindow } from 'tokenlens'
import { formatModel } from '../utils'

function getMaxTokens(model: string | null): number {
	const DEFAULT_CONTEXT = 200_000
	if (!model) return DEFAULT_CONTEXT
	try {
		return (
			getContextWindow(model).totalMax ?? DEFAULT_CONTEXT
		)
	} catch {
		return DEFAULT_CONTEXT
	}
}

export function BranchContext({
	stats
}: {
	stats: BranchStats
}) {
	if (stats.messageCount === 0) return null

	const usedTokens = stats.lastPromptTokens ?? 0
	const maxTokens = getMaxTokens(stats.model)
	const modelLabel = stats.model
		? stats.provider
			? `${stats.provider}/${formatModel(stats.model)}`
			: formatModel(stats.model)
		: null

	return (
		<Context
			maxTokens={maxTokens}
			modelId={stats.model ?? undefined}
			usage={{
				inputTokens: stats.promptTokens,
				outputTokens: stats.completionTokens
			}}
			usedTokens={usedTokens}
		>
			<ContextTrigger className="h-7 gap-1.5 p-0 text-[10px]" />
			<ContextContent align="center" side="top">
				{modelLabel && (
					<div className="px-3 py-2 text-[10px] font-mono text-muted-foreground tracking-wide">
						{modelLabel}
					</div>
				)}
				<ContextContentHeader />
				<ContextContentBody className="space-y-1">
					<ContextInputUsage />
					<ContextOutputUsage />
					<ContextReasoningUsage />
					<ContextCacheUsage />
					<div className="flex items-center justify-between text-xs">
						<span className="text-muted-foreground">
							Messages
						</span>
						<span>{stats.messageCount}</span>
					</div>
				</ContextContentBody>
				{stats.totalCost > 0 && <ContextContentFooter />}
			</ContextContent>
		</Context>
	)
}
