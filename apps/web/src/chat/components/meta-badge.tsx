import { cn } from '@/lib/utils'

export function MetaBadge({ label }: { label: string }) {
	return (
		<span
			className={cn(
				'rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'
			)}
		>
			{label}
		</span>
	)
}
