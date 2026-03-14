import type { ContentPart } from '@ellie/schemas/chat'
import { ImageGenGallery } from './image-gen-gallery'
import { ImageGenRecipe } from './image-gen-recipe'

type ImageGenPart = Extract<
	ContentPart,
	{ type: 'image-generation' }
>

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
			{hasRealImage ? (
				<ImageGenGallery part={part} />
			) : (
				preview && (
					<img
						src={`data:image/jpeg;base64,${preview}`}
						alt="Generating..."
						className="max-h-80 rounded-lg object-contain"
					/>
				)
			)}
			{isComplete && part.prompt && (
				<div className="font-mono text-[10px] italic text-muted-foreground/70">
					&ldquo;{part.prompt}&rdquo;
				</div>
			)}
			{isComplete && part.recipe && (
				<ImageGenRecipe recipe={part.recipe} />
			)}
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
