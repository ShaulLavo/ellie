import type { ContentPart } from '@ellie/schemas/chat'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import {
	CloudArrowDownIcon,
	DownloadSimpleIcon,
	GearSixIcon,
	ImageSquareIcon,
	WarningCircleIcon
} from '@phosphor-icons/react'
import { ImageIcon } from 'lucide-react'

type ImageGenPart = Extract<
	ContentPart,
	{ type: 'image-generation' }
>

type ProgressEntry = NonNullable<
	ImageGenPart['entries']
>[number]

/** Groups consecutive entries that share the same phase into one row. */
export interface PhaseGroup {
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

export function groupByPhase(
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

/** Remove trailing " X/Y" from labels since we render step counts separately. */
export function stripStepSuffix(label: string): string {
	return label.replace(/\s+\d+\/\d+$/, '')
}

export function buildSummary(
	part: ImageGenPart,
	currentEntry?: ProgressEntry
): string {
	if (part.status === 'error') {
		return 'Image generation failed'
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

export function groupVisualStatus(
	part: ImageGenPart,
	group: PhaseGroup,
	groupIndex: number,
	totalGroups: number
): 'complete' | 'active' | 'pending' {
	if (group.latest.status === 'completed') return 'complete'
	if (group.latest.status === 'failed') return 'active'

	if (
		group.maxStep != null &&
		group.totalSteps != null &&
		group.maxStep >= group.totalSteps
	) {
		return 'complete'
	}

	if (groupIndex < totalGroups - 1) return 'complete'

	if (part.status === 'running' || part.status === 'error')
		return 'active'

	return 'complete'
}

export function iconForPhase(
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
		case 'adetailer':
			return GearSixIcon
		case 'save':
			return CloudArrowDownIcon
		default:
			return ImageIcon
	}
}
