import type { ImgHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import {
	AnimatePresence,
	LayoutGroup,
	motion
} from 'motion/react'
import { cn } from '@/lib/utils'
import {
	getClickableImageContainerStyle,
	getClickableImagePlaceholderStyle,
	getClickableImagePlaceholderUrl
} from './clickable-image.utils'
import { useClickableImage } from './use-clickable-image'

type ClickableImageProps = Omit<
	ImgHTMLAttributes<HTMLImageElement>,
	| 'onAnimationStart'
	| 'onDragStart'
	| 'onDragEnd'
	| 'onDrag'
> & {
	containerClassName?: string
	naturalWidth?: number
	naturalHeight?: number
	hash?: string
}

export function ClickableImage({
	src,
	alt,
	className,
	containerClassName,
	naturalWidth,
	naturalHeight,
	hash,
	onLoad,
	...props
}: ClickableImageProps) {
	const {
		closeImage,
		handleThumbnailLoad,
		isOpen,
		layoutId,
		loaded,
		openImage
	} = useClickableImage()
	const placeholderUrl =
		getClickableImagePlaceholderUrl(hash)
	const containerStyle = getClickableImageContainerStyle({
		naturalHeight,
		naturalWidth
	})
	const placeholderStyle =
		getClickableImagePlaceholderStyle(placeholderUrl)

	return (
		<LayoutGroup>
			<button
				type="button"
				className={cn(
					'block max-w-full cursor-pointer overflow-hidden p-0 text-left',
					containerClassName,
					className
				)}
				style={{
					...containerStyle,
					...placeholderStyle
				}}
				onClick={openImage}
				aria-expanded={isOpen}
			>
				<motion.img
					layoutId={layoutId}
					src={src}
					alt={alt}
					className={cn(
						'block h-auto max-w-full object-contain transition-opacity duration-300',
						!loaded && hash && 'opacity-0'
					)}
					loading="lazy"
					onLoad={event => {
						handleThumbnailLoad()
						onLoad?.(event)
					}}
					{...props}
				/>
			</button>

			{createPortal(
				<AnimatePresence>
					{isOpen && (
						<motion.div
							className="fixed inset-0 z-100 flex items-center justify-center"
							exit={{ opacity: 1 }}
							role="dialog"
							aria-modal="true"
						>
							<motion.button
								type="button"
								aria-label="Close expanded image"
								className="absolute inset-0 bg-black/80 backdrop-blur-sm"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.2 }}
								onClick={closeImage}
							/>
							<div className="relative max-h-[90vh] max-w-[90vw]">
								<motion.img
									layoutId={layoutId}
									src={src}
									alt={alt}
									className="block max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
								/>
							</div>
						</motion.div>
					)}
				</AnimatePresence>,
				document.body
			)}
		</LayoutGroup>
	)
}
