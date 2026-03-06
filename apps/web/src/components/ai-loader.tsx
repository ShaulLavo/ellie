import { motion } from 'motion/react'
import { cn } from '@/lib/utils'

interface AILoaderProps {
	className?: string
}

/**
 * Spinning concentric-ring loader themed with --primary.
 * Two conic-gradient rings (one counter-rotating) with a subtle breathing scale.
 */
export function AILoader({ className }: AILoaderProps) {
	return (
		<motion.div
			className={cn('relative', className)}
			animate={{ scale: [1, 1.02, 1] }}
			transition={{
				duration: 4,
				repeat: Number.POSITIVE_INFINITY,
				ease: [0.4, 0, 0.6, 1]
			}}
		>
			{/* Primary ring */}
			<motion.div
				className="absolute inset-0 rounded-full"
				style={{
					background:
						'conic-gradient(from 0deg, transparent 0deg, var(--primary) 120deg, color-mix(in srgb, var(--primary), transparent 50%) 240deg, transparent 360deg)',
					mask: 'radial-gradient(circle, transparent 42%, black 44%, black 48%, transparent 50%)',
					WebkitMask:
						'radial-gradient(circle, transparent 42%, black 44%, black 48%, transparent 50%)',
					opacity: 0.9
				}}
				animate={{ rotate: [0, 360] }}
				transition={{
					duration: 2.5,
					repeat: Number.POSITIVE_INFINITY,
					ease: [0.4, 0, 0.6, 1]
				}}
			/>
			{/* Counter-rotation accent ring */}
			<motion.div
				className="absolute inset-0 rounded-full"
				style={{
					background:
						'conic-gradient(from 180deg, transparent 0deg, color-mix(in srgb, var(--primary), transparent 40%) 45deg, transparent 90deg)',
					mask: 'radial-gradient(circle, transparent 52%, black 54%, black 56%, transparent 58%)',
					WebkitMask:
						'radial-gradient(circle, transparent 52%, black 54%, black 56%, transparent 58%)',
					opacity: 0.35
				}}
				animate={{ rotate: [0, -360] }}
				transition={{
					duration: 4,
					repeat: Number.POSITIVE_INFINITY,
					ease: [0.4, 0, 0.6, 1]
				}}
			/>
		</motion.div>
	)
}
