import { SunHorizonIcon } from '@phosphor-icons/react'
import type { ContentPart } from '@ellie/schemas/chat'
import {
	Checkpoint,
	CheckpointIcon
} from '@/components/ai-elements/checkpoint'

type CheckpointPart = Extract<
	ContentPart,
	{ type: 'checkpoint' }
>
type ArtifactPart = Extract<
	ContentPart,
	{ type: 'artifact' }
>

export function CheckpointPartRenderer({
	part
}: {
	part: CheckpointPart
}) {
	return (
		<Checkpoint>
			<CheckpointIcon>
				<SunHorizonIcon className="size-4 shrink-0" />
			</CheckpointIcon>
			<span className="shrink-0 text-xs">
				{part.message}
			</span>
		</Checkpoint>
	)
}

export function ArtifactPartRenderer({
	part
}: {
	part: ArtifactPart
}) {
	return (
		<div className="text-sm">
			<span className="font-medium">
				{part.title ?? part.filename}
			</span>
			<pre className="mt-2 text-xs overflow-auto max-h-64">
				{part.content}
			</pre>
		</div>
	)
}
