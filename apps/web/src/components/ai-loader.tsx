import { cn } from '@/lib/utils'

interface AILoaderProps {
	className?: string
}

/**
 * Spinning concentric-ring loader using theme colors.
 * Pure SVG + CSS keyframes — no JS animation runtime.
 */
export function AILoader({ className }: AILoaderProps) {
	return (
		<div className={cn('relative', className)}>
			<svg
				viewBox="0 0 240 240"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				className="w-full h-full"
				aria-label="Loading"
			>
				<title>Loading</title>

				<style>
					{`
						@keyframes ai-loader-cw {
							from { transform: rotate(0deg); }
							to { transform: rotate(360deg); }
						}
						@keyframes ai-loader-ccw {
							from { transform: rotate(360deg); }
							to { transform: rotate(0deg); }
						}
						.ai-loader-spin circle {
							transform-origin: 120px 120px;
						}
						.ai-loader-spin circle:nth-child(1) { animation: ai-loader-cw 6s linear infinite; }
						.ai-loader-spin circle:nth-child(2) { animation: ai-loader-ccw 5s linear infinite; }
						.ai-loader-spin circle:nth-child(3) { animation: ai-loader-cw 7s linear infinite; }
						.ai-loader-spin circle:nth-child(4) { animation: ai-loader-ccw 4.5s linear infinite; }
					`}
				</style>

				<g
					className="ai-loader-spin"
					strokeWidth="18"
					strokeDasharray="15% 45%"
					strokeLinecap="round"
				>
					<circle
						r="100"
						cx="120"
						cy="120"
						stroke="var(--primary)"
						opacity="0.9"
					/>
					<circle
						r="80"
						cx="120"
						cy="120"
						stroke="var(--muted-foreground)"
						opacity="0.4"
					/>
					<circle
						r="60"
						cx="120"
						cy="120"
						stroke="var(--primary)"
						opacity="0.55"
					/>
					<circle
						r="40"
						cx="120"
						cy="120"
						stroke="var(--foreground)"
						opacity="0.2"
					/>
				</g>
			</svg>
		</div>
	)
}
