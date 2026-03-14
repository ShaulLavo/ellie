import { AnimatePresence, motion } from 'motion/react'
import type { ContentPart } from '@ellie/schemas/chat'
import { ImageGenGallery } from './image-gen-gallery'
import { ImageGenRecipe } from './image-gen-recipe'

type ImageGenPart = Extract<
	ContentPart,
	{ type: 'image-generation' }
>

const fadeIn = {
	initial: { opacity: 0, y: 4 },
	animate: { opacity: 1, y: 0 },
	exit: { opacity: 0 },
	transition: { duration: 0.3 }
} as const

export function ImageGenResult({
	part
}: {
	part: ImageGenPart
}) {
	const preview = findLatestPreview(part)
	const isComplete = part.status === 'complete'
	const hasRealImage =
		isComplete &&
		((part.images && part.images.length > 0) || part.url)

	if (!hasRealImage && !preview) return null

	return (
		<div className="space-y-2">
			<AnimatePresence mode="wait">
				{hasRealImage ? (
					<motion.div key="gallery" {...fadeIn}>
						<ImageGenGallery part={part} />
					</motion.div>
				) : (
					preview && (
						<motion.div key="preview" {...fadeIn}>
							<img
								src={`data:image/jpeg;base64,${preview}`}
								alt="Generating..."
								className="max-h-80 rounded-lg object-contain"
								style={
									part.recipe
										? {
												aspectRatio: `${part.recipe.width} / ${part.recipe.height}`
											}
										: undefined
								}
							/>
						</motion.div>
					)
				)}
			</AnimatePresence>
			<AnimatePresence>
				{isComplete && part.prompt && (
					<motion.div
						className="font-mono text-[10px] italic text-muted-foreground/70"
						{...fadeIn}
					>
						&ldquo;{part.prompt}&rdquo;
					</motion.div>
				)}
			</AnimatePresence>
			<AnimatePresence>
				{isComplete && part.recipe && (
					<motion.div {...fadeIn}>
						<ImageGenRecipe recipe={part.recipe} />
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	)
}

function findLatestPreview(
	part: ImageGenPart
): string | undefined {
	if (part.preview) return part.preview

	const entries = part.entries
	if (!entries) return undefined

	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].preview) return entries[i].preview
	}

	return undefined
}
