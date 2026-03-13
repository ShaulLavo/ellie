import { CaretDownIcon } from '@phosphor-icons/react'
import type { ContentPart } from '@ellie/schemas/chat'
import {
	Task,
	TaskContent,
	TaskTrigger
} from '@/components/ai-elements/task'
import { ImageGenStatusIcon } from './image-gen-status-icon'
import { ImageGenPhaseList } from './image-gen-phase-list'
import { ImageGenResult } from './image-gen-result'
import {
	groupByPhase,
	buildSummary
} from '../utils/image-gen-utils'

type ImageGenPart = Extract<
	ContentPart,
	{ type: 'image-generation' }
>

export function ImageGenProgress({
	part
}: {
	part: ImageGenPart
}) {
	const entries = part.entries ?? []
	const summary = buildSummary(part, entries.at(-1))
	const groups = groupByPhase(entries)

	return (
		<Task
			className="my-2 max-w-xl"
			defaultOpen={part.status === 'running'}
		>
			<TaskTrigger
				className="w-full"
				title="Generating image"
			>
				<div className="flex w-full items-start gap-3 text-left">
					<div className="mt-0.5">
						<ImageGenStatusIcon status={part.status} />
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2 font-mono text-[11px] tracking-wide text-foreground">
							Generating image
							<CaretDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
						</div>
						{part.prompt && (
							<div className="mt-0.5 font-mono text-[10px] italic text-muted-foreground/70">
								&ldquo;{part.prompt}&rdquo;
							</div>
						)}
						<div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
							{summary}
						</div>
					</div>
				</div>
			</TaskTrigger>
			<TaskContent className="mt-0">
				<div className="space-y-3">
					<ImageGenPhaseList part={part} groups={groups} />

					{part.status === 'error' && part.error && (
						<div className="font-mono text-[10px] text-destructive">
							{part.error}
						</div>
					)}

					<ImageGenResult part={part} />
				</div>
			</TaskContent>
		</Task>
	)
}
