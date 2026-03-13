import { useEffect, useEffectEvent, useState } from 'react'
import { WifiOffIcon } from 'lucide-react'
import type { ConnectionState } from '@ellie/schemas/chat'
import { SpinningLoader } from './spinning-loader'

const SHOW_DELAY_MS = 3_000

export function ConnectionIndicator({
	state,
	error
}: {
	state: ConnectionState
	error: string | null
}) {
	const [
		connectingDelayElapsed,
		setConnectingDelayElapsed
	] = useState(false)

	const onStateChange = useEffectEvent(
		(current: ConnectionState) => {
			if (current !== 'connecting') {
				setConnectingDelayElapsed(false)
			}
		}
	)

	useEffect(() => {
		onStateChange(state)
		if (state !== 'connecting') return
		const timer = setTimeout(
			() => setConnectingDelayElapsed(true),
			SHOW_DELAY_MS
		)
		return () => clearTimeout(timer)
	}, [state])

	const visible =
		state === 'error' ||
		state === 'disconnected' ||
		(state === 'connecting' && connectingDelayElapsed)

	if (!visible) return null

	const isError = state === 'error'

	return (
		<div className="flex items-center gap-3 py-2">
			{isError ? (
				<div className="flex size-10 items-center justify-center">
					<WifiOffIcon className="size-5 text-destructive" />
				</div>
			) : (
				<SpinningLoader className="size-10" />
			)}
			<div className="flex flex-col gap-0.5">
				<span className="text-sm font-medium">
					Server Unreachable
				</span>
				<span className="text-xs text-muted-foreground">
					{isError
						? (error ??
							'Connection failed after multiple attempts.')
						: 'Attempting to reconnect...'}
				</span>
			</div>
		</div>
	)
}
