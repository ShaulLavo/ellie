import {
	Loader2Icon,
	WifiOffIcon,
	AlertCircleIcon
} from 'lucide-react'
import type { ConnectionState } from '@ellie/schemas/chat'

export function ConnectionIndicator({
	state,
	error,
	onRetry
}: {
	state: ConnectionState
	error: string | null
	onRetry: () => void
}) {
	if (state === 'connected' && !error) return null

	return (
		<div className="flex items-center gap-2 px-5 py-1.5 border-b border-border/60">
			{state === 'connecting' && (
				<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<Loader2Icon className="size-3 animate-spin" />
					Connecting...
				</span>
			)}
			{state === 'disconnected' && (
				<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<WifiOffIcon className="size-3" />
					Disconnected
				</span>
			)}
			{state === 'error' && (
				<button
					type="button"
					onClick={onRetry}
					className="flex items-center gap-1.5 text-[11px] text-destructive hover:underline"
				>
					<AlertCircleIcon className="size-3" />
					Connection error — click to retry
				</button>
			)}
			{error && (
				<span className="text-[11px] text-destructive">
					{error}
				</span>
			)}
		</div>
	)
}
