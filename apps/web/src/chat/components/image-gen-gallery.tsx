import type { ContentPart } from '@ellie/schemas/chat'
import { ClickableImage } from '@/components/ui/clickable-image'

type ImageGenPart = Extract<
	ContentPart,
	{ type: 'image-generation' }
>

export function ImageGenGallery({
	part
}: {
	part: ImageGenPart
}) {
	if (part.images && part.images.length > 0) {
		return (
			<div
				className={
					part.images.length > 1
						? 'grid grid-cols-2 gap-2'
						: ''
				}
			>
				{part.images.map((img, i) => (
					<ClickableImage
						key={img.uploadId}
						src={img.url}
						alt={`Generated image ${i + 1}`}
						className="max-h-80 rounded-lg object-contain"
					/>
				))}
			</div>
		)
	}

	if (part.url) {
		return (
			<ClickableImage
				src={part.url}
				alt="Generated image"
				className="max-h-80 rounded-lg object-contain"
			/>
		)
	}

	return null
}
