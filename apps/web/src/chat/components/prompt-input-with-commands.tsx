import {
	useCallback,
	useEffect,
	useState,
	type RefObject
} from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { SlashCommandMenu } from './slash-command-menu'
import type { SlashCommand } from './slash-command-menu'
import {
	PromptInput,
	PromptInputTextarea,
	PromptInputFooter,
	PromptInputTools,
	PromptInputSubmit,
	PromptInputHeader,
	usePromptInputController,
	usePromptInputAttachments
} from '@/components/ai-elements/prompt-input'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import { MicRecordButton } from '@/components/ai-elements/mic-record-button'
import {
	GlobeIcon,
	PaperclipIcon,
	UploadSimpleIcon
} from '@phosphor-icons/react'
import { useFileDragOver } from '../../hooks/use-file-drag-over'
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
import { cn } from '@/lib/utils'
import { transcribeAudio } from '@/lib/speech-client'

export function PromptInputWithCommands({
	commands,
	onSubmit,
	disabled,
	speechRefRef
}: {
	commands: SlashCommand[]
	onSubmit: (message: PromptInputMessage) => void
	disabled: boolean
	speechRefRef?: RefObject<string | null>
}) {
	const controller = usePromptInputController()
	const inputValue = controller.textInput.value
	const [showSearch, setShowSearch] = useState(false)
	const [isPickerOpen, setIsPickerOpen] = useState(false)

	// Detect when the native file picker closes via window re-focus
	useEffect(() => {
		if (!isPickerOpen) return
		const handleFocus = () => setIsPickerOpen(false)
		window.addEventListener('focus', handleFocus)
		return () =>
			window.removeEventListener('focus', handleFocus)
	}, [isPickerOpen])

	const handleAudioRecorded = useCallback(
		async (audioBlob: Blob) => {
			try {
				const result = await transcribeAudio(audioBlob)
				if (speechRefRef) {
					speechRefRef.current = result.speechRef
				}
				return result.text
			} catch (err) {
				console.error(
					'[PromptInput] Transcription failed:',
					err instanceof Error ? err.message : String(err)
				)
				return ''
			}
		},
		[speechRefRef]
	)

	const handleTranscriptionChange = useCallback(
		(text: string) => {
			controller.textInput.setInput(text)
		},
		[controller]
	)

	const handleCommandSelect = (cmd: SlashCommand) => {
		controller.textInput.clear()
		cmd.action()
	}

	const isFileDragging = useFileDragOver()
	const [isDragOver, setIsDragOver] = useState(false)

	return (
		<div className="relative">
			<SlashCommandMenu
				commands={commands}
				inputValue={inputValue}
				onSelect={handleCommandSelect}
			/>

			{/* Drop zone overlay — positioned over the entire PromptInput */}
			<AnimatePresence>
				{isFileDragging && (
					<motion.div
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.15 }}
						onDragOver={e => {
							e.preventDefault()
							setIsDragOver(true)
						}}
						onDragLeave={() => setIsDragOver(false)}
						onDrop={e => {
							e.preventDefault()
							setIsDragOver(false)
							if (e.dataTransfer?.files?.length) {
								controller.attachments.add(
									Array.from(e.dataTransfer.files)
								)
							}
						}}
						className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-primary bg-background"
					>
						{/* Aura — edge glows from all 4 sides, like file-upload.tsx */}
						<div
							className={cn(
								'pointer-events-none absolute inset-0 transition-opacity duration-300',
								isDragOver ? 'opacity-100' : 'opacity-60'
							)}
						>
							<div className="absolute inset-x-0 top-0 h-[20%] bg-linear-to-b from-primary/10 to-transparent" />
							<div className="absolute inset-x-0 bottom-0 h-[20%] bg-linear-to-t from-primary/10 to-transparent" />
							<div className="absolute inset-y-0 left-0 w-[20%] bg-linear-to-r from-primary/10 to-transparent" />
							<div className="absolute inset-y-0 right-0 w-[20%] bg-linear-to-l from-primary/10 to-transparent" />
							<div className="absolute inset-[20%] animate-pulse rounded-lg bg-primary/5 transition-all duration-300" />
						</div>

						<motion.div
							initial={{ y: 6, opacity: 0, scale: 0.9 }}
							animate={{
								y: 0,
								opacity: 1,
								scale: isDragOver ? 1.1 : 1
							}}
							transition={{
								type: 'spring',
								stiffness: 300,
								damping: 22,
								delay: 0.04
							}}
							className="flex flex-col items-center gap-1.5"
						>
							<UploadSimpleIcon
								weight="duotone"
								className="size-7 text-primary"
							/>
							<span className="text-sm font-medium text-primary">
								Drop it like it's hot
							</span>
						</motion.div>
					</motion.div>
				)}
			</AnimatePresence>

			<PromptInput onSubmit={onSubmit} multiple>
				<PromptInputAttachments />
				<PromptInputTextarea placeholder="Type a message..." />
				<PromptInputFooter>
					<PromptInputTools>
						<button
							type="button"
							onClick={() => {
								setIsPickerOpen(true)
								controller.attachments.openFileDialog()
							}}
							className={cn(
								'rounded-lg transition-all flex items-center gap-2 px-1.5 py-1 border h-8 cursor-pointer',
								isPickerOpen
									? 'bg-primary/15 border-primary text-primary'
									: 'bg-black/5 dark:bg-white/5 border-transparent text-muted-foreground hover:text-foreground'
							)}
						>
							<div className="flex size-4 shrink-0 items-center justify-center">
								<motion.div
									animate={{
										rotate: isPickerOpen ? -45 : 0,
										scale: isPickerOpen ? 1.1 : 1
									}}
									whileHover={{
										rotate: isPickerOpen ? -45 : -15,
										scale: 1.1,
										transition: {
											type: 'spring',
											stiffness: 300,
											damping: 10
										}
									}}
									transition={{
										type: 'spring',
										stiffness: 260,
										damping: 25
									}}
								>
									<PaperclipIcon className="size-4" />
								</motion.div>
							</div>
							<AnimatePresence>
								{isPickerOpen && (
									<motion.span
										initial={{
											width: 0,
											opacity: 0
										}}
										animate={{
											width: 'auto',
											opacity: 1
										}}
										exit={{
											width: 0,
											opacity: 0
										}}
										transition={{ duration: 0.2 }}
										className="shrink-0 overflow-hidden whitespace-nowrap text-primary text-sm"
									>
										Attach
									</motion.span>
								)}
							</AnimatePresence>
						</button>
						<button
							type="button"
							onClick={() => setShowSearch(!showSearch)}
							className={cn(
								'rounded-lg transition-all flex items-center gap-2 px-1.5 py-1 border h-8 cursor-pointer',
								showSearch
									? 'bg-primary/15 border-primary text-primary'
									: 'bg-black/5 dark:bg-white/5 border-transparent text-muted-foreground hover:text-foreground'
							)}
						>
							<div className="flex size-4 shrink-0 items-center justify-center">
								<motion.div
									animate={{
										rotate: showSearch ? 180 : 0,
										scale: showSearch ? 1.1 : 1
									}}
									whileHover={{
										rotate: showSearch ? 180 : 15,
										scale: 1.1,
										transition: {
											type: 'spring',
											stiffness: 300,
											damping: 10
										}
									}}
									transition={{
										type: 'spring',
										stiffness: 260,
										damping: 25
									}}
								>
									<GlobeIcon
										className={cn(
											'size-4',
											showSearch
												? 'text-primary'
												: 'text-inherit'
										)}
									/>
								</motion.div>
							</div>
							<AnimatePresence>
								{showSearch && (
									<motion.span
										initial={{ width: 0, opacity: 0 }}
										animate={{
											width: 'auto',
											opacity: 1
										}}
										exit={{ width: 0, opacity: 0 }}
										transition={{ duration: 0.2 }}
										className="shrink-0 overflow-hidden whitespace-nowrap text-primary text-sm"
									>
										Search
									</motion.span>
								)}
							</AnimatePresence>
						</button>
						<MicRecordButton
							forceMediaRecorder
							onAudioRecorded={handleAudioRecorded}
							onTranscriptionChange={
								handleTranscriptionChange
							}
						/>
					</PromptInputTools>
					<PromptInputSubmit disabled={disabled} />
				</PromptInputFooter>
			</PromptInput>
		</div>
	)
}

function PromptInputAttachments() {
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
