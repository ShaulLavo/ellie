import type { ContentPart } from '@ellie/schemas/chat'
import { ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import { StepProgressBar } from './step-progress-bar'
import {
	stripStepSuffix,
	groupVisualStatus,
	iconForPhase,
	type PhaseGroup
} from '../utils/image-gen-utils'

type ImageGenPart = Extract<
	ContentPart,
	{ type: 'image-generation' }
>

export function ImageGenPhaseList({
	part,
	groups
}: {
	part: ImageGenPart
	groups: PhaseGroup[]
}) {
	if (groups.length === 0) {
		return (
			<div className="font-mono text-[10px] text-muted-foreground">
				No progress events yet.
			</div>
		)
	}

	return (
		<div className="space-y-3">
			{groups.map((group, gi) => (
				<ChainOfThoughtStep
					key={group.id}
					icon={iconForPhase(group.phase, group.latest)}
					label={
						<div className="font-mono text-[11px] leading-tight">
							{stripStepSuffix(group.latest.label)}
							{group.maxStep != null &&
								group.totalSteps != null && (
									<span className="ml-1 text-muted-foreground">
										{group.maxStep}/{group.totalSteps}
									</span>
								)}
						</div>
					}
					description={
						group.latest.detail?.trim() || undefined
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
	)
}
