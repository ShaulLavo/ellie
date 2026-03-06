import { AILoader } from '@/components/ai-loader'

export function EmptyState({
	needsBootstrap
}: {
	needsBootstrap: boolean
}) {
	return (
		<div className="flex size-full flex-col items-center justify-center gap-5 p-8">
			<AILoader className="size-16" />
			<div className="space-y-1 text-center">
				{needsBootstrap ? (
					<>
						<h3 className="font-display text-sm font-semibold tracking-tight text-foreground/80">
							Say hi to your agent
						</h3>
						<p className="text-[13px] text-muted-foreground/70">
							Send your first message to get started.
						</p>
					</>
				) : (
					<>
						<h3 className="font-display text-sm font-semibold tracking-tight text-foreground/80">
							Start a conversation
						</h3>
						<p className="text-[13px] text-muted-foreground/70">
							Send a message below to begin.
						</p>
					</>
				)}
			</div>
		</div>
	)
}
