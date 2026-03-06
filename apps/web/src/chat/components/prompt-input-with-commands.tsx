import { useState } from 'react'
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
import {
	GlobeIcon,
	MicrophoneIcon,
	PaperclipIcon
} from '@phosphor-icons/react'
import { AttachmentPreviews } from '@/components/attachment-previews'
import { cn } from '@/lib/utils'

export function PromptInputWithCommands({
	commands,
	onSubmit,
	disabled
}: {
	commands: SlashCommand[]
	onSubmit: (message: PromptInputMessage) => void
	disabled: boolean
}) {
	const controller = usePromptInputController()
	const inputValue = controller.textInput.value
	const [showSearch, setShowSearch] = useState(false)

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
							onClick={() =>
								controller.attachments.openFileDialog()
							}
							className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-black/5 text-muted-foreground transition-all hover:text-foreground dark:bg-white/5"
						>
							<motion.div
								whileHover={{
									rotate: -15,
									scale: 1.1,
									transition: {
										type: 'spring',
										stiffness: 300,
										damping: 10
									}
								}}
							>
								<PaperclipIcon className="size-4" />
							</motion.div>
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
						<button
							type="button"
							className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-black/5 text-muted-foreground transition-all hover:text-foreground dark:bg-white/5"
						>
							<motion.div
								whileHover={{
									scale: 1.15,
									transition: {
										type: 'spring',
										stiffness: 300,
										damping: 10
									}
								}}
							>
								<MicrophoneIcon className="size-4" />
							</motion.div>
						</button>
					</PromptInputTools>
					<PromptInputSubmit disabled={disabled} />
				</PromptInputFooter>
			</PromptInput>
		</div>
	)
}
