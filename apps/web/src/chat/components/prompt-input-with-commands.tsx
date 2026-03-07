import {
	useCallback,
	useEffect,
	useState,
	type MutableRefObject
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
	usePromptInputController
} from '@/components/ai-elements/prompt-input'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import { MicRecordButton } from '@/components/ai-elements/mic-record-button'
import {
	GlobeIcon,
	PaperclipIcon
} from '@phosphor-icons/react'
import { AttachmentPreviews } from '@/components/attachment-previews'
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
	speechRefRef?: MutableRefObject<string | null>
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

	return (
		<div className="relative">
			<SlashCommandMenu
				commands={commands}
				inputValue={inputValue}
				onSelect={handleCommandSelect}
			/>
			<PromptInput onSubmit={onSubmit}>
				<AttachmentPreviews />
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
