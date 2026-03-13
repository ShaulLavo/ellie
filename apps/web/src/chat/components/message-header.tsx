import { formatTime } from '../utils'

export function MessageHeader({
	sender,
	timestamp
}: {
	sender?: string
	timestamp: string
}) {
	return (
		<div className="flex items-baseline gap-1.5 text-[10.5px] text-muted-foreground group-[.is-user]:justify-end">
			{sender && (
				<span className="font-medium text-foreground/60">
					{sender}
				</span>
			)}
			<span className="text-muted-foreground/50">
				{formatTime(timestamp)}
			</span>
		</div>
	)
}
