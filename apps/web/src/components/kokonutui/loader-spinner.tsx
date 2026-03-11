'use client'

import { motion, type HTMLMotionProps } from 'motion/react'
import { cn } from '@/lib/utils'

const sizeConfig = {
	sm: 'size-20',
	md: 'size-32',
	lg: 'size-40'
} as const

const spinnerPalette = {
	primary: 'var(--primary)',
	primarySoft:
		'color-mix(in srgb, var(--primary), transparent 45%)',
	foreground: 'var(--foreground)',
	foregroundSoft:
		'color-mix(in srgb, var(--foreground), transparent 45%)',
	mutedSoft:
		'color-mix(in srgb, var(--muted-foreground), transparent 40%)',
	foregroundStrong:
		'color-mix(in srgb, var(--foreground), transparent 35%)',
	primaryStrong:
		'color-mix(in srgb, var(--primary), transparent 35%)'
} as const

export interface LoaderSpinnerProps extends HTMLMotionProps<'div'> {
	size?: keyof typeof sizeConfig
}

export function LoaderSpinner({
	size = 'md',
	className,
	...props
}: LoaderSpinnerProps) {
	return (
		<motion.div
			className={cn(
				'relative',
				sizeConfig[size],
				className
			)}
			animate={{
				scale: [1, 1.02, 1]
			}}
			transition={{
				duration: 4,
				repeat: Number.POSITIVE_INFINITY,
				ease: [0.4, 0, 0.6, 1]
			}}
			{...props}
		>
			<motion.div
				className="absolute inset-0 rounded-full"
				style={{
					background: `conic-gradient(from 0deg, transparent 0deg, ${spinnerPalette.primary} 90deg, transparent 180deg)`,
					mask: `radial-gradient(circle at 50% 50%, transparent 35%, black 37%, black 39%, transparent 41%)`,
					WebkitMask: `radial-gradient(circle at 50% 50%, transparent 35%, black 37%, black 39%, transparent 41%)`,
					opacity: 0.8
				}}
				animate={{
					rotate: [0, 360]
				}}
				transition={{
					duration: 3,
					repeat: Number.POSITIVE_INFINITY,
					ease: 'linear'
				}}
			/>

			<motion.div
				className="absolute inset-0 rounded-full"
				style={{
					background: `conic-gradient(from 0deg, transparent 0deg, ${spinnerPalette.foreground} 120deg, ${spinnerPalette.foregroundSoft} 240deg, transparent 360deg)`,
					mask: `radial-gradient(circle at 50% 50%, transparent 42%, black 44%, black 48%, transparent 50%)`,
					WebkitMask: `radial-gradient(circle at 50% 50%, transparent 42%, black 44%, black 48%, transparent 50%)`,
					opacity: 0.9
				}}
				animate={{
					rotate: [0, 360]
				}}
				transition={{
					duration: 2.5,
					repeat: Number.POSITIVE_INFINITY,
					ease: [0.4, 0, 0.6, 1]
				}}
			/>

			<motion.div
				className="absolute inset-0 rounded-full"
				style={{
					background: `conic-gradient(from 180deg, transparent 0deg, ${spinnerPalette.primarySoft} 45deg, transparent 90deg)`,
					mask: `radial-gradient(circle at 50% 50%, transparent 52%, black 54%, black 56%, transparent 58%)`,
					WebkitMask: `radial-gradient(circle at 50% 50%, transparent 52%, black 54%, black 56%, transparent 58%)`,
					opacity: 0.35
				}}
				animate={{
					rotate: [0, -360]
				}}
				transition={{
					duration: 4,
					repeat: Number.POSITIVE_INFINITY,
					ease: [0.4, 0, 0.6, 1]
				}}
			/>

			<motion.div
				className="absolute inset-0 rounded-full"
				style={{
					background: `conic-gradient(from 270deg, transparent 0deg, ${spinnerPalette.mutedSoft} 20deg, transparent 40deg)`,
					mask: `radial-gradient(circle at 50% 50%, transparent 61%, black 62%, black 63%, transparent 64%)`,
					WebkitMask: `radial-gradient(circle at 50% 50%, transparent 61%, black 62%, black 63%, transparent 64%)`,
					opacity: 0.5
				}}
				animate={{
					rotate: [0, 360]
				}}
				transition={{
					duration: 3.5,
					repeat: Number.POSITIVE_INFINITY,
					ease: 'linear'
				}}
			/>

			<motion.div
				className="hidden absolute inset-0 rounded-full dark:block"
				style={{
					background: `conic-gradient(from 0deg, transparent 0deg, ${spinnerPalette.foreground} 90deg, transparent 180deg)`,
					mask: `radial-gradient(circle at 50% 50%, transparent 35%, black 37%, black 39%, transparent 41%)`,
					WebkitMask: `radial-gradient(circle at 50% 50%, transparent 35%, black 37%, black 39%, transparent 41%)`,
					opacity: 0.8
				}}
				animate={{
					rotate: [0, 360]
				}}
				transition={{
					duration: 3,
					repeat: Number.POSITIVE_INFINITY,
					ease: 'linear'
				}}
			/>

			<motion.div
				className="hidden absolute inset-0 rounded-full dark:block"
				style={{
					background: `conic-gradient(from 0deg, transparent 0deg, ${spinnerPalette.primary} 120deg, ${spinnerPalette.primaryStrong} 240deg, transparent 360deg)`,
					mask: `radial-gradient(circle at 50% 50%, transparent 42%, black 44%, black 48%, transparent 50%)`,
					WebkitMask: `radial-gradient(circle at 50% 50%, transparent 42%, black 44%, black 48%, transparent 50%)`,
					opacity: 0.9
				}}
				animate={{
					rotate: [0, 360]
				}}
				transition={{
					duration: 2.5,
					repeat: Number.POSITIVE_INFINITY,
					ease: [0.4, 0, 0.6, 1]
				}}
			/>

			<motion.div
				className="hidden absolute inset-0 rounded-full dark:block"
				style={{
					background: `conic-gradient(from 180deg, transparent 0deg, ${spinnerPalette.foregroundStrong} 45deg, transparent 90deg)`,
					mask: `radial-gradient(circle at 50% 50%, transparent 52%, black 54%, black 56%, transparent 58%)`,
					WebkitMask: `radial-gradient(circle at 50% 50%, transparent 52%, black 54%, black 56%, transparent 58%)`,
					opacity: 0.35
				}}
				animate={{
					rotate: [0, -360]
				}}
				transition={{
					duration: 4,
					repeat: Number.POSITIVE_INFINITY,
					ease: [0.4, 0, 0.6, 1]
				}}
			/>

			<motion.div
				className="hidden absolute inset-0 rounded-full dark:block"
				style={{
					background: `conic-gradient(from 270deg, transparent 0deg, ${spinnerPalette.primaryStrong} 20deg, transparent 40deg)`,
					mask: `radial-gradient(circle at 50% 50%, transparent 61%, black 62%, black 63%, transparent 64%)`,
					WebkitMask: `radial-gradient(circle at 50% 50%, transparent 61%, black 62%, black 63%, transparent 64%)`,
					opacity: 0.5
				}}
				animate={{
					rotate: [0, 360]
				}}
				transition={{
					duration: 3.5,
					repeat: Number.POSITIVE_INFINITY,
					ease: 'linear'
				}}
			/>
		</motion.div>
	)
}

export default LoaderSpinner
