import { XIcon, FileIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
	usePromptInputAttachments,
	PromptInputHeader
} from '@/components/ai-elements/prompt-input'

export function AttachmentPreviews() {
	const { files, remove } = usePromptInputAttachments()

	if (files.length === 0) return null

	return (
		<PromptInputHeader>
			{files.map(file => {
				const isImage = file.mediaType?.startsWith('image/')
				return (
					<div
						key={file.id}
						className="group/attachment relative inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1.5 text-xs"
					>
						{isImage ? (
							<img
								src={file.url}
								alt={file.filename ?? ''}
								className="h-8 w-8 rounded object-cover"
							/>
						) : (
							<FileIcon className="size-4 text-muted-foreground" />
						)}
						<span className="max-w-[120px] truncate">
							{file.filename ?? 'file'}
						</span>
						<Button
							variant="ghost"
							size="icon-sm"
							className="size-5 opacity-0 group-hover/attachment:opacity-100 transition-opacity"
							onClick={() => remove(file.id)}
						>
							<XIcon className="size-3" />
							<span className="sr-only">Remove</span>
						</Button>
					</div>
				)
			})}
		</PromptInputHeader>
	)
}
