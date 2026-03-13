import { useEffect, useRef } from 'react'

export function SpinningLoader({
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
