import { memo } from 'react'
import {
	CheckCircleIcon,
	ImageIcon,
	XCircleIcon
} from 'lucide-react'
import {
	CaretDownIcon,
	CircleNotchIcon,
	CloudArrowDownIcon,
	GearSixIcon,
	ImageSquareIcon,
	QueueIcon,
	WarningCircleIcon
} from '@phosphor-icons/react'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import type { ContentPart } from '@ellie/schemas/chat'
import { ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import {
	Task,
	TaskContent,
	TaskTrigger
} from '@/components/ai-elements/task'
import { cn } from '@/lib/utils'

type ImageGenPart = Extract<
	ContentPart,
	{ type: 'image-generation' }
>

type ProgressEntry = NonNullable<
	ImageGenPart['entries']
>[number]

export const ImageGenProgress = memo(
	({ part }: { part: ImageGenPart }) => {
		const entries = part.entries ?? []
		const currentEntry = entries.at(-1)
		const summary = buildSummary(part, currentEntry)

		return (
			<Task
				className="my-2 max-w-xl rounded-lg border border-border/50 bg-card/50 p-3"
				defaultOpen={part.status === 'running'}
			>
				<TaskTrigger
					className="w-full"
					title="Generating image"
				>
					<div className="flex w-full items-start gap-3 text-left">
						<div className="mt-0.5">
							{part.status === 'error' ? (
								<XCircleIcon className="size-4 text-destructive" />
							) : part.status === 'complete' ? (
								<CheckCircleIcon className="size-4 text-emerald-500" />
							) : (
								<CircleNotchIcon className="size-4 animate-spin text-muted-foreground" />
							)}
						</div>
						<div className="min-w-0 flex-1">
							<div className="font-mono text-[11px] tracking-wide text-foreground">
								Generating image
							</div>
							<div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
								{summary}
							</div>
						</div>
						<CaretDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
					</div>
				</TaskTrigger>
				<TaskContent className="mt-0">
					<div className="space-y-3">
						{entries.length > 0 ? (
							<div className="space-y-3">
								{entries.map((entry, index) => (
									<ChainOfThoughtStep
										key={entry.id}
										icon={iconForEntry(entry)}
										label={
											<div className="font-mono text-[11px] leading-tight">
												{entry.label}
												{renderStepCount(entry)}
											</div>
										}
										description={formatEntryDescription(
											entry
										)}
										status={visualStatusForEntry(
											part,
											entry,
											index,
											entries.length
										)}
									/>
								))}
							</div>
						) : (
							<div className="font-mono text-[10px] text-muted-foreground">
								No progress events yet.
							</div>
						)}

						{part.status === 'error' && part.error && (
							<div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-[10px] text-destructive">
								{part.error}
							</div>
						)}

						{part.status === 'complete' && (
							<div className="space-y-2">
								{part.url && (
									<img
										src={part.url}
										alt="Generated image"
										className="max-h-80 rounded-lg object-contain"
										loading="lazy"
									/>
								)}
								{part.recipe && (
									<div className="flex flex-wrap gap-1">
										<MetaBadge label={part.recipe.model} />
										<MetaBadge
											label={`${part.recipe.width}x${part.recipe.height}`}
										/>
										<MetaBadge
											label={`${part.recipe.steps}steps`}
										/>
										<MetaBadge
											label={`cfg${part.recipe.cfg}`}
										/>
										<MetaBadge
											label={`seed:${part.recipe.seed}`}
										/>
										<MetaBadge
											label={`${(part.recipe.durationMs / 1000).toFixed(1)}s`}
										/>
										{part.recipe.loras?.map(lora => (
											<MetaBadge
												key={lora.name}
												label={`lora:${lora.name}`}
											/>
										))}
									</div>
								)}
							</div>
						)}
					</div>
				</TaskContent>
			</Task>
		)
	}
)

function buildSummary(
	part: ImageGenPart,
	currentEntry?: ProgressEntry
): string {
	if (part.status === 'error') {
		return part.error ?? 'Image generation failed'
	}
	if (part.status === 'complete') {
		if (part.elapsedMs != null) {
			return `Completed in ${(part.elapsedMs / 1000).toFixed(1)}s`
		}
		return 'Completed'
	}
	if (!currentEntry) {
		return 'Waiting for progress updates...'
	}
	return (
		formatEntryDescription(currentEntry) ??
		currentEntry.label
	)
}

function visualStatusForEntry(
	part: ImageGenPart,
	entry: ProgressEntry,
	index: number,
	totalEntries: number
): 'complete' | 'active' | 'pending' {
	if (entry.status === 'failed') {
		return 'active'
	}
	if (
		part.status === 'running' &&
		index === totalEntries - 1
	) {
		return 'active'
	}
	if (
		part.status === 'error' &&
		index === totalEntries - 1
	) {
		return 'active'
	}
	return 'complete'
}

function formatEntryDescription(
	entry: ProgressEntry
): string | undefined {
	const detail = entry.detail?.trim()
	const count = renderStepCount(entry)
	if (detail && count) return `${detail} ${count}`
	return detail ?? count ?? undefined
}

function renderStepCount(
	entry: ProgressEntry
): string | undefined {
	if (entry.step == null || entry.totalSteps == null) {
		return undefined
	}
	return `(${entry.step}/${entry.totalSteps})`
}

function iconForEntry(entry: ProgressEntry): PhosphorIcon {
	if (entry.status === 'failed') {
		return WarningCircleIcon
	}

	switch (entry.phase) {
		case 'setup':
			return GearSixIcon
		case 'queue':
			return QueueIcon
		case 'denoising':
			return ImageSquareIcon
		case 'fetch':
		case 'save':
			return CloudArrowDownIcon
		default:
			return ImageIcon
	}
}

function MetaBadge({ label }: { label: string }) {
	return (
		<span
			className={cn(
				'rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'
			)}
		>
			{label}
		</span>
	)
}
