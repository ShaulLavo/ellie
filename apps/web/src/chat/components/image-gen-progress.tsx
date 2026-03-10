import { memo } from 'react'
import {
	CheckCircleIcon,
	XCircleIcon,
	ImageIcon
} from 'lucide-react'
import {
	GearSixIcon,
	QueueIcon,
	PaintBrushIcon,
	DownloadSimpleIcon,
	FloppyDiskIcon,
	CircleNotchIcon
} from '@phosphor-icons/react'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import type { ContentPart } from '@ellie/schemas/chat'
import { env } from '@ellie/env/client'
import { cn } from '@/lib/utils'

type ImageGenPart = Extract<
	ContentPart,
	{ type: 'image-generation' }
>

/** Ordered pipeline phases with display info. */
const PHASES: Array<{
	id: string
	label: string
	icon: PhosphorIcon
}> = [
	{ id: 'setup', label: 'Setting up', icon: GearSixIcon },
	{ id: 'queue', label: 'Queuing', icon: QueueIcon },
	{
		id: 'denoising',
		label: 'Generating',
		icon: PaintBrushIcon
	},
	{
		id: 'fetch',
		label: 'Downloading',
		icon: DownloadSimpleIcon
	},
	{ id: 'save', label: 'Saving', icon: FloppyDiskIcon }
]

export const ImageGenProgress = memo(
	({ part }: { part: ImageGenPart }) => {
		if (part.status === 'complete') {
			return <CompletedView part={part} />
		}
		if (part.status === 'error') {
			return <ErrorView part={part} />
		}
		return <RunningView part={part} />
	}
)

function RunningView({ part }: { part: ImageGenPart }) {
	const completed = new Set(part.completedPhases ?? [])
	const activePhase = part.phase

	return (
		<div className="my-2 max-w-sm space-y-0 rounded-lg border border-border/50 p-3">
			<div className="mb-2 flex items-center gap-2">
				<ImageIcon className="size-4 text-muted-foreground" />
				<span className="font-mono text-[11px] tracking-wide text-foreground">
					Generating image
				</span>
			</div>
			<div className="space-y-0">
				{PHASES.map((phase, i) => {
					const isCompleted = completed.has(phase.id)
					const isActive = activePhase === phase.id
					const isPending = !isCompleted && !isActive

					const status: StepStatus = isCompleted
						? 'complete'
						: isActive
							? 'active'
							: 'pending'

					// Only show phases that are completed, active, or the next pending one
					if (
						isPending &&
						!completed.has(PHASES[i - 1]?.id ?? '') &&
						i > 0
					)
						return null

					return (
						<Step
							key={phase.id}
							icon={phase.icon}
							label={phase.label}
							status={status}
							isLast={i === PHASES.length - 1 || isPending}
							step={isActive ? part.step : undefined}
							totalSteps={
								isActive ? part.totalSteps : undefined
							}
							detail={isActive ? part.detail : undefined}
						/>
					)
				})}
			</div>
		</div>
	)
}

type StepStatus = 'complete' | 'active' | 'pending'

const statusStyles: Record<StepStatus, string> = {
	active: 'text-foreground',
	complete: 'text-muted-foreground',
	pending: 'text-muted-foreground/50'
}

function Step({
	icon: Icon,
	label,
	status,
	isLast,
	step,
	totalSteps,
	detail
}: {
	icon: PhosphorIcon
	label: string
	status: StepStatus
	isLast: boolean
	step?: number
	totalSteps?: number
	detail?: string
}) {
	const hasSteps = step != null && totalSteps != null
	const percent = hasSteps
		? Math.round((step! / totalSteps!) * 100)
		: undefined

	return (
		<div
			className={cn(
				'flex gap-2 text-sm',
				statusStyles[status],
				status !== 'pending' &&
					'fade-in-0 slide-in-from-top-1 animate-in'
			)}
		>
			<div className="relative mt-0.5 flex flex-col items-center">
				{status === 'active' ? (
					<CircleNotchIcon className="size-3.5 animate-spin" />
				) : (
					<Icon className="size-3.5" />
				)}
				{!isLast && (
					<div className="mt-0.5 w-px flex-1 bg-border" />
				)}
			</div>
			<div className="flex-1 space-y-1 overflow-hidden pb-2">
				<div className="font-mono text-[11px] leading-tight">
					{label}
					{hasSteps && ` ${step}/${totalSteps}`}
				</div>
				{hasSteps && percent != null && (
					<div className="h-1 w-full overflow-hidden rounded-full bg-muted">
						<div
							className="h-full rounded-full bg-primary transition-all duration-300"
							style={{
								width: `${percent}%`
							}}
						/>
					</div>
				)}
				{detail && (
					<div className="font-mono text-[10px] text-muted-foreground">
						{detail}
					</div>
				)}
			</div>
		</div>
	)
}

function CompletedView({ part }: { part: ImageGenPart }) {
	const recipe = part.recipe
	return (
		<div className="my-2 max-w-sm">
			{part.uploadId && (
				<img
					src={`${env.API_BASE_URL.replace(/\/$/, '')}/api/uploads-rpc/${encodeURIComponent(part.uploadId)}/content`}
					alt="Generated image"
					className="max-h-80 rounded-lg object-contain"
					loading="lazy"
				/>
			)}
			{recipe && (
				<div className="mt-1.5 flex flex-wrap gap-1">
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
					{recipe.loras?.map(l => (
						<MetaBadge
							key={l.name}
							label={`lora:${l.name}`}
						/>
					))}
				</div>
			)}
			{part.elapsedMs != null && !recipe && (
				<div className="mt-1 flex items-center gap-1.5">
					<CheckCircleIcon className="size-3 text-muted-foreground" />
					<span className="font-mono text-[10px] text-muted-foreground">
						{(part.elapsedMs / 1000).toFixed(1)}s
					</span>
				</div>
			)}
		</div>
	)
}

function ErrorView({ part }: { part: ImageGenPart }) {
	return (
		<div className="my-2 flex max-w-sm items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
			<XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
			<div className="min-w-0">
				<span className="font-mono text-[11px] text-destructive">
					Image generation failed
				</span>
				{part.error && (
					<span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
						{part.error}
					</span>
				)}
			</div>
		</div>
	)
}

function MetaBadge({ label }: { label: string }) {
	return (
		<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
			{label}
		</span>
	)
}
