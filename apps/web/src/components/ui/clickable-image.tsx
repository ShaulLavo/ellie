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

const MAX_CHAT_IMAGE_HEIGHT_PX = 320

export function ClickableImage({
	src,
	alt,
	className,
	containerClassName,
	naturalWidth,
	naturalHeight,
	...props
}: Omit<
	React.ImgHTMLAttributes<HTMLImageElement>,
	| 'onAnimationStart'
	| 'onDragStart'
	| 'onDragEnd'
	| 'onDrag'
> & {
	containerClassName?: string
	naturalWidth?: number
	naturalHeight?: number
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

	const aspectStyle =
		naturalWidth && naturalHeight
			? ({
					aspectRatio: `${naturalWidth} / ${naturalHeight}`
				} as React.CSSProperties)
			: undefined
	const boundedWidth =
		naturalWidth && naturalHeight
			? Math.min(
					naturalWidth,
					(naturalWidth / naturalHeight) *
						MAX_CHAT_IMAGE_HEIGHT_PX
				)
			: undefined
	const containerStyle =
		aspectStyle && boundedWidth
			? ({
					...aspectStyle,
					width: `min(100%, ${boundedWidth}px)`
				} as React.CSSProperties)
			: aspectStyle

	return (
		<LayoutGroup>
			<motion.button
				layoutId={layoutId}
				type="button"
				className={cn(
					'block max-w-full cursor-pointer overflow-hidden p-0 text-left',
					containerClassName,
					className,
					open && 'invisible'
				)}
				style={containerStyle}
				onClick={() => setOpen(true)}
			>
				<img
					src={src}
					alt={alt}
					className="block h-auto max-w-full object-contain"
					loading="lazy"
					{...props}
				/>
			</motion.button>

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
							<motion.div
								layoutId={layoutId}
								className="max-h-[90vh] max-w-[90vw] overflow-hidden rounded-lg shadow-2xl"
								onClick={e => e.stopPropagation()}
							>
								<img
									src={src}
									alt={alt}
									className="block max-h-[90vh] max-w-[90vw] object-contain"
								/>
							</motion.div>
						</motion.div>
					)}
				</AnimatePresence>,
				document.body
			)}
		</LayoutGroup>
	)
}
