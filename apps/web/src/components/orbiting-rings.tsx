import { cn } from '@/lib/utils'

/**
 * Orbiting concentric rings with small particles.
 * Pure CSS animation using the `orbit` keyframe from styles.css.
 */
export function OrbitingRings({
	className
}: {
	className?: string
}) {
	return (
		<div
			className={cn(
				'relative flex items-center justify-center',
				className
			)}
		>
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
	)
}
