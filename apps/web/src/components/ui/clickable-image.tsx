import {
	useState,
	useCallback,
	useEffect,
	useId
} from 'react'
import { createPortal } from 'react-dom'
import {
	motion,
	AnimatePresence,
	LayoutGroup
} from 'motion/react'
import { cn } from '@/lib/utils'

export function ClickableImage({
	src,
	alt,
	className,
	containerClassName,
	...props
}: Omit<
	React.ImgHTMLAttributes<HTMLImageElement>,
	| 'onAnimationStart'
	| 'onDragStart'
	| 'onDragEnd'
	| 'onDrag'
> & {
	containerClassName?: string
}) {
	const [open, setOpen] = useState(false)
	const layoutId = useId()

	const close = useCallback(() => setOpen(false), [])

	useEffect(() => {
		if (!open) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') close()
		}
		document.addEventListener('keydown', onKey)
		return () =>
			document.removeEventListener('keydown', onKey)
	}, [open, close])

	return (
		<LayoutGroup>
			<div
				className={cn('cursor-pointer', containerClassName)}
			>
				<motion.img
					layoutId={layoutId}
					src={src}
					alt={alt}
					className={cn(
						className,
						'cursor-pointer',
						open && 'invisible'
					)}
					loading="lazy"
					onClick={() => setOpen(true)}
					{...props}
				/>
			</div>

			{createPortal(
				<AnimatePresence>
					{open && (
						<motion.div
							className="fixed inset-0 z-100 flex items-center justify-center bg-black/80 backdrop-blur-sm"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.2 }}
							onClick={close}
						>
							<motion.img
								layoutId={layoutId}
								src={src}
								alt={alt}
								className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
								onClick={e => e.stopPropagation()}
							/>
						</motion.div>
					)}
				</AnimatePresence>,
				document.body
			)}
		</LayoutGroup>
	)
}
