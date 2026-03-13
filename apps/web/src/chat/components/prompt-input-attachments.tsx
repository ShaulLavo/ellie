import { usePromptInputAttachments } from '@/components/ai-elements/prompt-input'
import { PromptInputHeader } from '@/components/ai-elements/prompt-input'
import {
	Attachments,
	Attachment,
	AttachmentPreview,
	AttachmentInfo,
	AttachmentRemove,
	AttachmentHoverCard,
	AttachmentHoverCardTrigger,
	AttachmentHoverCardContent,
	getAttachmentLabel,
	getMediaCategory
} from '@/components/ai-elements/attachments'

export function PromptInputAttachments() {
	const { files, remove } = usePromptInputAttachments()

	if (files.length === 0) return null

	return (
		<PromptInputHeader>
			<Attachments variant="inline">
				{files.map(file => {
					const mediaCategory = getMediaCategory(file)
					const label = getAttachmentLabel(file)

					return (
						<AttachmentHoverCard key={file.id}>
							<AttachmentHoverCardTrigger>
								<Attachment
									data={file}
									onRemove={() => remove(file.id)}
								>
									<div className="relative size-5 shrink-0">
										<div className="absolute inset-0 transition-opacity group-hover:opacity-0">
											<AttachmentPreview />
										</div>
										<AttachmentRemove className="absolute inset-0" />
									</div>
									<AttachmentInfo />
								</Attachment>
							</AttachmentHoverCardTrigger>
							<AttachmentHoverCardContent>
								<div className="space-y-3">
									{mediaCategory === 'image' &&
										file.type === 'file' &&
										file.url && (
											<div className="flex max-h-96 w-80 items-center justify-center overflow-hidden rounded-md border">
												<img
													alt={label}
													className="max-h-full max-w-full object-contain"
													height={384}
													src={file.url}
													width={320}
												/>
											</div>
										)}
									<div className="space-y-1 px-0.5">
										<h4 className="font-semibold text-sm leading-none">
											{label}
										</h4>
										{file.mediaType && (
											<p className="font-mono text-muted-foreground text-xs">
												{file.mediaType}
											</p>
										)}
									</div>
								</div>
							</AttachmentHoverCardContent>
						</AttachmentHoverCard>
					)
				})}
			</Attachments>
		</PromptInputHeader>
	)
}
