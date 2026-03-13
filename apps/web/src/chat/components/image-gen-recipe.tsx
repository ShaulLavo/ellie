import type { ContentPart } from '@ellie/schemas/chat'
import { MetaBadge } from './meta-badge'

type ImageGenPart = Extract<
	ContentPart,
	{ type: 'image-generation' }
>

export function ImageGenRecipe({
	recipe
}: {
	recipe: NonNullable<ImageGenPart['recipe']>
}) {
	return (
		<div className="flex flex-wrap gap-1">
			<MetaBadge label={recipe.model} />
			<MetaBadge
				label={`${recipe.width}x${recipe.height}`}
			/>
			<MetaBadge label={`${recipe.steps}steps`} />
			<MetaBadge label={`cfg${recipe.cfg}`} />
			<MetaBadge label={`seed:${recipe.seed}`} />
			<MetaBadge
				label={`${(recipe.durationMs / 1000).toFixed(1)}s`}
			/>
			{recipe.loras?.map(lora => (
				<MetaBadge
					key={lora.name}
					label={`lora:${lora.name}`}
				/>
			))}
		</div>
	)
}
