import { motion, AnimatePresence } from 'motion/react'
import { GlobeIcon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'

export function SearchToggleButton({
	showSearch,
	onToggle
}: {
	showSearch: boolean
	onToggle: () => void
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className={cn(
				'rounded-lg transition-all flex items-center gap-2 px-1.5 py-1 border h-8 cursor-pointer',
				showSearch
					? 'bg-primary/15 border-primary text-primary'
					: 'bg-black/5 dark:bg-white/5 border-transparent text-muted-foreground hover:text-foreground'
			)}
		>
			<div className="flex size-4 shrink-0 items-center justify-center">
				<motion.div
					animate={{
						rotate: showSearch ? 180 : 0,
						scale: showSearch ? 1.1 : 1
					}}
					whileHover={{
						rotate: showSearch ? 180 : 15,
						scale: 1.1,
						transition: {
							type: 'spring',
							stiffness: 300,
							damping: 10
						}
					}}
					transition={{
						type: 'spring',
						stiffness: 260,
						damping: 25
					}}
				>
					<GlobeIcon
						className={cn(
							'size-4',
							showSearch ? 'text-primary' : 'text-inherit'
						)}
					/>
				</motion.div>
			</div>
			<AnimatePresence>
				{showSearch && (
					<motion.span
						initial={{ width: 0, opacity: 0 }}
						animate={{
							width: 'auto',
							opacity: 1
						}}
						exit={{ width: 0, opacity: 0 }}
						transition={{ duration: 0.2 }}
						className="shrink-0 overflow-hidden whitespace-nowrap text-primary text-sm"
					>
						Search
					</motion.span>
				)}
			</AnimatePresence>
		</button>
	)
}
