import { FileTextIcon } from 'lucide-react'
import type { ContentPart } from '@ellie/schemas/chat'
import { ClickableImage } from '@/components/ui/clickable-image'
import { VoiceMessage } from '../voice-message'

type ImagePart = Extract<ContentPart, { type: 'image' }>
type VideoPart = Extract<ContentPart, { type: 'video' }>
type AudioPart = Extract<ContentPart, { type: 'audio' }>
type FilePart = Extract<ContentPart, { type: 'file' }>
type AssistantArtifactPart = Extract<
	ContentPart,
	{ type: 'assistant-artifact' }
>

export function ImagePartRenderer({
	part
}: {
	part: ImagePart
}) {
	if (!part.url) return null
	return (
		<ClickableImage
			src={part.url}
			alt={
				(part as ContentPart & { name?: string }).name ??
				'Image'
			}
			className="max-h-80 rounded-lg object-contain"
			containerClassName="my-2 max-w-sm"
			naturalWidth={part.width}
			naturalHeight={part.height}
			hash={part.hash}
		/>
	)
}

export function VideoPartRenderer({
	part
}: {
	part: VideoPart
}) {
	if (!part.url) return null
	return (
		<div className="my-2 max-w-sm">
			<video
				src={part.url}
				controls
				className="max-h-80 rounded-lg"
			/>
		</div>
	)
}

export function AudioPartRenderer({
	part
}: {
	part: AudioPart
}) {
	if (!part.url) return null
	return (
		<div>
			<VoiceMessage
				src={part.url}
				duration={part.duration}
				waveform={part.waveform}
			/>
		</div>
	)
}

export function FilePartRenderer({
	part
}: {
	part: FilePart
}) {
	const hasUpload = !!part.url
	const label = part.name ?? 'Attachment'
	const sizeLabel =
		part.size >= 1024
			? `${(part.size / 1024).toFixed(1)} KB`
			: `${part.size} B`
	const inner = (
		<>
			<FileTextIcon className="size-5 shrink-0 text-muted-foreground" />
			<div className="min-w-0">
				<span className="block truncate font-medium">
					{label}
				</span>
				<span className="text-xs text-muted-foreground">
					{sizeLabel}
				</span>
			</div>
		</>
	)
	return hasUpload ? (
		<a
			href={part.url}
			target="_blank"
			rel="noopener noreferrer"
			className="my-2 flex max-w-xs items-center gap-2 text-sm transition-colors hover:text-accent-foreground"
			download={part.name}
		>
			{inner}
		</a>
	) : (
		<div className="my-2 flex max-w-xs items-center gap-2 text-sm">
			{inner}
		</div>
	)
}

export function AssistantArtifactPartRenderer({
	part
}: {
	part: AssistantArtifactPart
}) {
	const resolvedUrl =
		part.url ||
		`/api/uploads-rpc/${encodeURIComponent(part.uploadId)}/content`
	const resolvedKind =
		part.mediaKind ||
		(part.kind === 'audio' ? 'audio' : 'file')

	if (resolvedKind === 'image') {
		return (
			<ClickableImage
				src={resolvedUrl}
				alt="Attached media"
				className="max-h-80 rounded-lg object-contain"
				containerClassName="my-2 max-w-sm"
				naturalWidth={part.width}
				naturalHeight={part.height}
				hash={part.hash}
			/>
		)
	}

	if (resolvedKind === 'video') {
		return (
			<div className="my-2 max-w-sm">
				<video
					src={resolvedUrl}
					controls
					className="max-h-80 rounded-lg"
				/>
			</div>
		)
	}

	if (resolvedKind === 'audio') {
		return (
			<div className="my-2">
				<VoiceMessage src={resolvedUrl} />
			</div>
		)
	}

	return (
		<a
			href={resolvedUrl}
			target="_blank"
			rel="noopener noreferrer"
			className="my-2 flex max-w-xs items-center gap-2 text-sm transition-colors hover:text-accent-foreground"
		>
			<FileTextIcon className="size-5 shrink-0 text-muted-foreground" />
			<div className="min-w-0">
				<span className="block truncate font-medium">
					Attached media
				</span>
				<span className="text-xs text-muted-foreground">
					{part.uploadId}
				</span>
			</div>
		</a>
	)
}
