import {
	ListIcon,
	InfoIcon,
	Trash2Icon
} from 'lucide-react'
import { ThemeToggle } from '@/components/theme-toggle'
import { eden } from '@/lib/eden'

export function ChatToolbar({
	onShowSessions,
	onShowInfo
}: {
	onShowSessions: () => void
	onShowInfo: () => void
}) {
	return (
		<div className="flex items-center gap-1 px-5 py-1.5 border-b border-border/60">
			<button
				type="button"
				onClick={onShowSessions}
				className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
			>
				<ListIcon className="size-3" />
				Sessions
			</button>
			<button
				type="button"
				onClick={onShowInfo}
				className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
			>
				<InfoIcon className="size-3" />
				Info
			</button>
			<div className="flex-1" />
			<ThemeToggle />
			<button
				type="button"
				onClick={async () => {
					await eden.api.dev.reset.post()
					setTimeout(() => window.location.reload(), 1500)
				}}
				className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-destructive hover:bg-destructive/10 transition-colors"
			>
				<Trash2Icon className="size-3" />
				Reset
			</button>
		</div>
	)
}
