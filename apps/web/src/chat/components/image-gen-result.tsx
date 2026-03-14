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
	if (part.status !== 'complete') return null

	return (
		<div className="space-y-2">
			<ImageGenGallery part={part} />
			{part.prompt && (
				<div className="font-mono text-[10px] italic text-muted-foreground/70">
					&ldquo;{part.prompt}&rdquo;
				</div>
			)}
			{part.recipe && (
				<ImageGenRecipe recipe={part.recipe} />
			)}
		</div>
	)
}
