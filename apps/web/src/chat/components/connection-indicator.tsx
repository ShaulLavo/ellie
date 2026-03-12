import { useEffect, useState, useRef } from 'react'
import { WifiOffIcon } from 'lucide-react'
import type { ConnectionState } from '@ellie/schemas/chat'

const SHOW_DELAY_MS = 3_000

function SpinningLoader({
	className
}: {
	className?: string
}) {
	const outerRef = useRef<HTMLDivElement>(null)
	const innerRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		let frame: number
		let start: number | null = null
		function animate(ts: number) {
			if (!start) start = ts
			const elapsed = ts - start
			if (outerRef.current) {
				outerRef.current.style.transform = `rotate(${(elapsed * 0.18) % 360}deg)`
			}
			if (innerRef.current) {
				innerRef.current.style.transform = `rotate(${-(elapsed * 0.12) % 360}deg)`
			}
			frame = requestAnimationFrame(animate)
		}
		frame = requestAnimationFrame(animate)
		return () => cancelAnimationFrame(frame)
	}, [])

	return (
		<div className={`relative ${className ?? 'size-10'}`}>
			<div
				ref={outerRef}
				className="absolute inset-0 rounded-full"
				style={{
					background:
						'conic-gradient(from 0deg, transparent 0deg, var(--primary) 120deg, color-mix(in srgb, var(--primary), transparent 50%) 240deg, transparent 360deg)',
					mask: 'radial-gradient(circle, transparent 42%, black 44%, black 48%, transparent 50%)',
					opacity: 0.9
				}}
			/>
			<div
				ref={innerRef}
				className="absolute inset-0 rounded-full"
				style={{
					background:
						'conic-gradient(from 180deg, transparent 0deg, color-mix(in srgb, var(--primary), transparent 40%) 45deg, transparent 90deg)',
					mask: 'radial-gradient(circle, transparent 52%, black 54%, black 56%, transparent 58%)',
					opacity: 0.35
				}}
			/>
		</div>
	)
}

export function ConnectionIndicator({
	state,
	error
}: {
	state: ConnectionState
	error: string | null
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
		if (state === 'connecting') {
			const timer = setTimeout(
				() => setVisible(true),
				SHOW_DELAY_MS
			)
			return () => clearTimeout(timer)
		}
		// disconnected
		setVisible(true)
	}, [state])

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
