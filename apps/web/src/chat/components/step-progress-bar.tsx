import { cn } from '@/lib/utils'

export function StepProgressBar({
	step,
	totalSteps
}: {
	step: number
	totalSteps: number
}) {
	const pct = Math.min(
		100,
		Math.round((step / totalSteps) * 100)
	)
	const isDone = step >= totalSteps

	return (
		<div className="flex max-w-[350px] items-center gap-2.5">
			<div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted/80">
				<div
					className={cn(
						'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out',
						'bg-primary'
					)}
					style={{ width: `${pct}%` }}
				/>
				{!isDone && (
					<div
						className="absolute inset-y-0 left-0 rounded-full bg-linear-to-r from-transparent to-white/25 transition-[width] duration-300 ease-out"
						style={{ width: `${pct}%` }}
					/>
				)}
			</div>
			<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
				{step}/{totalSteps}
			</span>
		</div>
	)
}
