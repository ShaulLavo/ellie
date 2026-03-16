import React from 'react'
import { cn } from '@/lib/utils'
import { useScrollFade } from '@/hooks/use-scroll-fade'

type ScrollAxis = 'horizontal' | 'vertical' | 'both'

interface ScrollFadeProps {
	children: React.ReactNode
	className?: string
	hideScrollbar?: boolean
	axis?: ScrollAxis
	intensity?: number
}

export default function ScrollFade({
	children,
	className,
	hideScrollbar = true,
	axis = 'horizontal',
	intensity = 1
}: ScrollFadeProps) {
	const { containerRef, contentRef, fades } =
		useScrollFade(axis)
	const fadeIntensity = Math.min(Math.max(intensity, 0), 1)

	return (
		<div className="relative">
			<div
				ref={containerRef}
				className={cn(
					hideScrollbar &&
						'[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
					axis === 'horizontal' &&
						'w-full overflow-x-auto overflow-y-hidden',
					axis === 'vertical' &&
						'h-full overflow-y-auto overflow-x-hidden',
					axis === 'both' && 'overflow-auto',
					className
				)}
			>
				<div
					ref={contentRef}
					className={cn(
						axis === 'horizontal' && 'w-fit min-w-full',
						axis === 'vertical' && 'h-fit min-h-full',
						axis === 'both' &&
							'min-w-full min-h-full w-fit h-fit'
					)}
				>
					{children}
				</div>
			</div>

			{(axis === 'horizontal' || axis === 'both') &&
				fades.left && (
					<div
						aria-hidden
						className="pointer-events-none absolute left-0 top-0 h-full w-10 z-10"
						style={{
							opacity: fadeIntensity,
							background: `linear-gradient(to right, var(--background), transparent)`
						}}
					/>
				)}

			{(axis === 'horizontal' || axis === 'both') &&
				fades.right && (
					<div
						aria-hidden
						className="pointer-events-none absolute right-0 top-0 h-full w-10 z-10"
						style={{
							opacity: fadeIntensity,
							background: `linear-gradient(to left, var(--background), transparent)`
						}}
					/>
				)}

			{(axis === 'vertical' || axis === 'both') &&
				fades.top && (
					<div
						aria-hidden
						className="pointer-events-none absolute top-0 left-0 w-full h-10 z-10"
						style={{
							opacity: fadeIntensity,
							background: `linear-gradient(to bottom, var(--background), transparent)`
						}}
					/>
				)}

			{(axis === 'vertical' || axis === 'both') &&
				fades.bottom && (
					<div
						aria-hidden
						className="pointer-events-none absolute bottom-0 left-0 w-full h-10 z-10"
						style={{
							opacity: fadeIntensity,
							background: `linear-gradient(to top, var(--background), transparent)`
						}}
					/>
				)}
		</div>
	)
}
