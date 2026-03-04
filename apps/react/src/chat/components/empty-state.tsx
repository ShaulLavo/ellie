export function EmptyState({
	needsBootstrap
}: {
	needsBootstrap: boolean
}) {
	return (
		<div className="flex size-full flex-col items-center justify-center gap-5 p-8">
			<div className="relative flex items-center justify-center">
				<div className="absolute size-32 rounded-full border border-primary/5 animate-orbit" />
				<div
					className="absolute size-24 rounded-full border border-primary/8"
					style={{
						animation: 'orbit 18s linear infinite reverse'
					}}
				/>
				<div
					className="absolute size-16 rounded-full border border-primary/10 animate-orbit"
					style={{ animationDuration: '8s' }}
				/>
				<div className="absolute size-32 animate-orbit">
					<div className="absolute -top-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-primary/30" />
				</div>
				<div
					className="absolute size-16 animate-orbit"
					style={{ animationDuration: '8s' }}
				>
					<div className="absolute top-1/2 -right-0.5 size-1 -translate-y-1/2 rounded-full bg-primary/25" />
				</div>
				<div className="relative size-9 rounded-full bg-primary/6 flex items-center justify-center">
					<div className="size-3.5 rounded-full bg-primary/15 animate-glow-pulse" />
				</div>
			</div>
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
