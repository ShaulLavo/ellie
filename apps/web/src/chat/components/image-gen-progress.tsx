import { memo, useMemo } from 'react'
import {
	CheckCircleIcon,
	ImageIcon,
	XCircleIcon
} from 'lucide-react'
import {
	CaretDownIcon,
	CloudArrowDownIcon,
	DownloadSimpleIcon,
	GearSixIcon,
	ImageSquareIcon,
	WarningCircleIcon
} from '@phosphor-icons/react'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import type { ContentPart } from '@ellie/schemas/chat'
import { ClickableImage } from '@/components/ui/clickable-image'
import { ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import {
	Task,
	TaskContent,
	TaskTrigger
} from '@/components/ai-elements/task'
import { LoadingAnimation } from '@/components/kokonutui/ai-loading'
import { cn } from '@/lib/utils'

type ImageGenPart = Extract<
	ContentPart,
	{ type: 'image-generation' }
>

type ProgressEntry = NonNullable<
	ImageGenPart['entries']
>[number]

/** Groups consecutive entries that share the same phase into one row. */
interface PhaseGroup {
	/** First entry id — used as React key */
	id: string
	phase: string
	/** Most recent entry in the group (has latest step/detail) */
	latest: ProgressEntry
	/** All entries in this group */
	entries: ProgressEntry[]
	/** Highest step value seen across all entries in the group */
	maxStep: number | null
	/** Total steps (from any entry that reported it) */
	totalSteps: number | null
}

function groupByPhase(
	entries: ProgressEntry[]
): PhaseGroup[] {
	const groups: PhaseGroup[] = []
	for (const entry of entries) {
		const last = groups.at(-1)
		if (last && last.phase === entry.phase) {
			last.latest = entry
			last.entries.push(entry)
			if (
				entry.step != null &&
				(last.maxStep == null || entry.step > last.maxStep)
			) {
				last.maxStep = entry.step
			}
			if (entry.totalSteps != null) {
				last.totalSteps = entry.totalSteps
			}
		} else {
			groups.push({
				id: entry.id,
				phase: entry.phase,
				latest: entry,
				entries: [entry],
				maxStep: entry.step ?? null,
				totalSteps: entry.totalSteps ?? null
			})
		}
	}
	return groups
}

export const ImageGenProgress = memo(
	({ part }: { part: ImageGenPart }) => {
		const entries = part.entries ?? []
		const currentEntry = entries.at(-1)
		const summary = buildSummary(part, currentEntry)
		const groups = useMemo(
			() => groupByPhase(entries),
			[entries]
		)

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
							{part.status === 'error' ? (
								<XCircleIcon className="size-4 text-destructive" />
							) : part.status === 'complete' ? (
								<CheckCircleIcon className="size-4 text-primary" />
							) : (
								<LoadingAnimation
									className="size-4"
									progress={100}
								/>
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
						{groups.length > 0 ? (
							<div className="space-y-3">
								{groups.map((group, gi) => (
									<ChainOfThoughtStep
										key={group.id}
										icon={iconForPhase(
											group.phase,
											group.latest
										)}
										label={
											<div className="font-mono text-[11px] leading-tight">
												{stripStepSuffix(
													group.latest.label
												)}
												{group.maxStep != null &&
													group.totalSteps != null && (
														<span className="ml-1 text-muted-foreground">
															{group.maxStep}/
															{group.totalSteps}
														</span>
													)}
											</div>
										}
										description={
											group.latest.detail?.trim() ||
											undefined
										}
										status={groupVisualStatus(
											part,
											group,
											gi,
											groups.length
										)}
									>
										{group.maxStep != null &&
											group.totalSteps != null && (
												<StepProgressBar
													step={group.maxStep}
													totalSteps={group.totalSteps}
												/>
											)}
									</ChainOfThoughtStep>
								))}
							</div>
						) : (
							<div className="font-mono text-[10px] text-muted-foreground">
								No progress events yet.
							</div>
						)}

						{part.status === 'error' && part.error && (
							<div className="font-mono text-[10px] text-destructive">
								{part.error}
							</div>
						)}

						{part.status === 'complete' && (
							<div className="space-y-2">
								{part.images && part.images.length > 0 ? (
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
								) : part.url ? (
									<ClickableImage
										src={part.url}
										alt="Generated image"
										className="max-h-80 rounded-lg object-contain"
									/>
								) : null}
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

function StepProgressBar({
	step,
	totalSteps
}: {
	step: number
	totalSteps: number
}) {
	const pct = Math.min(
		100,
		Math.round((step / totalSteps) * 100)
	)
	const isDone = step >= totalSteps

	return (
		<div className="flex items-center gap-2.5">
			<div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted/80">
				<div
					className={cn(
						'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out',
						'bg-primary'
					)}
					style={{ width: `${pct}%` }}
				/>
				{!isDone && (
					<div
						className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-transparent to-white/25 transition-[width] duration-300 ease-out"
						style={{ width: `${pct}%` }}
					/>
				)}
			</div>
			<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
				{step}/{totalSteps}
			</span>
		</div>
	)
}

/** Remove trailing " X/Y" from labels since we render step counts separately. */
function stripStepSuffix(label: string): string {
	return label.replace(/\s+\d+\/\d+$/, '')
}

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
	const detail = currentEntry.detail?.trim()
	return detail ?? currentEntry.label
}

function groupVisualStatus(
	part: ImageGenPart,
	group: PhaseGroup,
	groupIndex: number,
	totalGroups: number
): 'complete' | 'active' | 'pending' {
	// If the latest entry in the group is explicitly completed
	if (group.latest.status === 'completed') return 'complete'
	if (group.latest.status === 'failed') return 'active'

	// If step data exists and step reached totalSteps, it's done
	if (
		group.maxStep != null &&
		group.totalSteps != null &&
		group.maxStep >= group.totalSteps
	) {
		return 'complete'
	}

	// If it's not the last group, later groups exist so this one is done
	if (groupIndex < totalGroups - 1) return 'complete'

	// Last group while still running
	if (part.status === 'running' || part.status === 'error')
		return 'active'

	return 'complete'
}

function iconForPhase(
	phase: string,
	entry: ProgressEntry
): PhosphorIcon {
	if (entry.status === 'failed') {
		return WarningCircleIcon
	}

	switch (phase) {
		case 'setup':
			return GearSixIcon
		case 'download':
			return DownloadSimpleIcon
		case 'denoising':
			return ImageSquareIcon
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
