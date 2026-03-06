import { useEffect, useState } from 'react'
import { WifiOffIcon } from 'lucide-react'
import type { ConnectionState } from '@ellie/schemas/chat'
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogAction
} from '@/components/ui/alert-dialog'
import { AILoader } from '@/components/ai-loader'

const SHOW_DELAY_MS = 3_000

export function ServerDownOverlay({
	state,
	error,
	onRetry
}: {
	state: ConnectionState
	error: string | null
	onRetry: () => void
}) {
	const [visible, setVisible] = useState(false)

	useEffect(() => {
		if (state === 'error') {
			setVisible(true)
			return
		}
		if (state === 'connected') {
			setVisible(false)
			return
		}
		const timer = setTimeout(
			() => setVisible(true),
			SHOW_DELAY_MS
		)
		return () => clearTimeout(timer)
	}, [state])

	const isError = state === 'error'

	return (
		<AlertDialog open={visible}>
			<AlertDialogContent className="!max-w-xs">
				<AlertDialogHeader>
					<AlertDialogMedia className="!bg-transparent">
						{isError ? (
							<WifiOffIcon className="size-5 text-destructive" />
						) : (
							<AILoader className="size-10" />
						)}
					</AlertDialogMedia>
					<AlertDialogTitle>
						Server Unreachable
					</AlertDialogTitle>
					<AlertDialogDescription>
						{isError
							? (error ??
								'Connection failed after multiple attempts.')
							: 'Attempting to reconnect...'}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogAction
						size="sm"
						variant={isError ? 'default' : 'outline'}
						onClick={onRetry}
					>
						{isError ? 'Retry' : 'Retry Now'}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
