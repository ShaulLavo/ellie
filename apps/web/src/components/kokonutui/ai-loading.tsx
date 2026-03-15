import { useId } from 'react'
import { cn } from '@/lib/utils'

export function LoadingAnimation({
	progress,
	className
}: {
	progress: number
	className?: string
}) {
	const maskId = useId()

	return (
		<div className={cn('relative h-6 w-6', className)}>
			<svg
				viewBox="0 0 240 240"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				className="h-full w-full"
				aria-label={`Loading progress: ${Math.round(progress)}%`}
			>
				<title>Loading Progress Indicator</title>

				<defs>
					<mask id={maskId}>
						<rect width="240" height="240" fill="black" />
						<circle
							r="120"
							cx="120"
							cy="120"
							fill="white"
							strokeDasharray={`${(progress / 100) * 754}, 754`}
							transform="rotate(-90 120 120)"
						/>
					</mask>
				</defs>

				<style>
					{`
                    @keyframes rotate-cw {
                        from { transform: rotate(0deg); }
                        to { transform: rotate(360deg); }
                    }
                    @keyframes rotate-ccw {
                        from { transform: rotate(360deg); }
                        to { transform: rotate(0deg); }
                    }
                    .g-spin circle {
                        transform-origin: 120px 120px;
                    }
                    .g-spin circle:nth-child(1) { animation: rotate-cw 8s linear infinite; }
                    .g-spin circle:nth-child(2) { animation: rotate-ccw 8s linear infinite; }
                    .g-spin circle:nth-child(3) { animation: rotate-cw 8s linear infinite; }
                    .g-spin circle:nth-child(4) { animation: rotate-ccw 8s linear infinite; }
                    .g-spin circle:nth-child(5) { animation: rotate-cw 8s linear infinite; }
                    .g-spin circle:nth-child(6) { animation: rotate-ccw 8s linear infinite; }

                    .g-spin circle:nth-child(2n) { animation-delay: 0.2s; }
                    .g-spin circle:nth-child(3n) { animation-delay: 0.3s; }
                `}
				</style>

				<g
					className="g-spin"
					strokeWidth="16"
					strokeDasharray="18% 40%"
					mask={`url(#${maskId})`}
				>
					<circle
						r="150"
						cx="120"
						cy="120"
						stroke="var(--color-1)"
						opacity="0.95"
					/>
					<circle
						r="130"
						cx="120"
						cy="120"
						stroke="var(--primary)"
						opacity="0.95"
					/>
					<circle
						r="110"
						cx="120"
						cy="120"
						stroke="var(--color-3)"
						opacity="0.95"
					/>
					<circle
						r="90"
						cx="120"
						cy="120"
						stroke="var(--primary)"
						opacity="0.95"
					/>
					<circle
						r="70"
						cx="120"
						cy="120"
						stroke="var(--color-4)"
						opacity="0.95"
					/>
					<circle
						r="50"
						cx="120"
						cy="120"
						stroke="var(--color-5)"
						opacity="0.95"
					/>
				</g>
			</svg>
		</div>
	)
}
