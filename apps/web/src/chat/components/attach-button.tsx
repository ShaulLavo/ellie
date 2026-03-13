import { motion, AnimatePresence } from 'motion/react'
import { PaperclipIcon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'

export function AttachButton({
	isPickerOpen,
	onOpenPicker
}: {
	isPickerOpen: boolean
	onOpenPicker: () => void
}) {
	return (
		<button
			type="button"
			onClick={onOpenPicker}
			className={cn(
				'rounded-lg transition-all flex items-center gap-2 px-1.5 py-1 border h-8 cursor-pointer',
				isPickerOpen
					? 'bg-primary/15 border-primary text-primary'
					: 'bg-black/5 dark:bg-white/5 border-transparent text-muted-foreground hover:text-foreground'
			)}
		>
			<div className="flex size-4 shrink-0 items-center justify-center">
				<motion.div
					animate={{
						rotate: isPickerOpen ? -45 : 0,
						scale: isPickerOpen ? 1.1 : 1
					}}
					whileHover={{
						rotate: isPickerOpen ? -45 : -15,
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
					<PaperclipIcon className="size-4" />
				</motion.div>
			</div>
			<AnimatePresence>
				{isPickerOpen && (
					<motion.span
						initial={{
							width: 0,
							opacity: 0
						}}
						animate={{
							width: 'auto',
							opacity: 1
						}}
						exit={{
							width: 0,
							opacity: 0
						}}
						transition={{ duration: 0.2 }}
						className="shrink-0 overflow-hidden whitespace-nowrap text-primary text-sm"
					>
						Attach
					</motion.span>
				)}
			</AnimatePresence>
		</button>
	)
}
