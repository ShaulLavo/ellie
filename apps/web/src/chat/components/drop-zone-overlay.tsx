import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { UploadSimpleIcon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'

export function DropZoneOverlay({
	isFileDragging,
	onFilesDropped
}: {
	isFileDragging: boolean
	onFilesDropped: (files: File[]) => void
}) {
	const [isDragOver, setIsDragOver] = useState(false)

	return (
		<AnimatePresence>
			{isFileDragging && (
				<motion.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.15 }}
					onDragOver={e => {
						e.preventDefault()
						setIsDragOver(true)
					}}
					onDragLeave={() => setIsDragOver(false)}
					onDrop={e => {
						e.preventDefault()
						setIsDragOver(false)
						if (e.dataTransfer?.files?.length) {
							onFilesDropped(
								Array.from(e.dataTransfer.files)
							)
						}
					}}
					className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-primary bg-background"
				>
					{/* Aura — edge glows from all 4 sides */}
					<div
						className={cn(
							'pointer-events-none absolute inset-0 transition-opacity duration-300',
							isDragOver ? 'opacity-100' : 'opacity-60'
						)}
					>
						<div className="absolute inset-x-0 top-0 h-[20%] bg-linear-to-b from-primary/10 to-transparent" />
						<div className="absolute inset-x-0 bottom-0 h-[20%] bg-linear-to-t from-primary/10 to-transparent" />
						<div className="absolute inset-y-0 left-0 w-[20%] bg-linear-to-r from-primary/10 to-transparent" />
						<div className="absolute inset-y-0 right-0 w-[20%] bg-linear-to-l from-primary/10 to-transparent" />
						<div className="absolute inset-[20%] animate-pulse rounded-lg bg-primary/5 transition-all duration-300" />
					</div>

					<motion.div
						initial={{ y: 6, opacity: 0, scale: 0.9 }}
						animate={{
							y: 0,
							opacity: 1,
							scale: isDragOver ? 1.1 : 1
						}}
						transition={{
							type: 'spring',
							stiffness: 300,
							damping: 22,
							delay: 0.04
						}}
						className="flex flex-col items-center gap-1.5"
					>
						<UploadSimpleIcon
							weight="duotone"
							className="size-7 text-primary"
						/>
						<span className="text-sm font-medium text-primary">
							Drop it like it's hot
						</span>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	)
}
