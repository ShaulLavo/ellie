import type { RefObject } from 'react'
import type { SlashCommand } from './slash-command-menu'
import { SlashCommandMenu } from './slash-command-menu'
import {
	PromptInput,
	PromptInputTextarea,
	PromptInputFooter,
	PromptInputTools,
	PromptInputSubmit
} from '@/components/ai-elements/prompt-input'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import { MicRecordButton } from '@/components/ai-elements/mic-record-button'
import { PromptInputAttachments } from './prompt-input-attachments'
import { DropZoneOverlay } from './drop-zone-overlay'
import { AttachButton } from './attach-button'
import { SearchToggleButton } from './search-toggle-button'
import { usePromptInputLogic } from '../hooks/use-prompt-input-logic'

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
	const {
		inputValue,
		showSearch,
		isPickerOpen,
		isFileDragging,
		handleAudioRecorded,
		handleTranscriptionChange,
		handleCommandSelect,
		openFilePicker,
		toggleSearch,
		addFiles
	} = usePromptInputLogic(speechRefRef)

	return (
		<div className="relative">
			<SlashCommandMenu
				commands={commands}
				inputValue={inputValue}
				onSelect={handleCommandSelect}
			/>

			<DropZoneOverlay
				isFileDragging={isFileDragging}
				onFilesDropped={addFiles}
			/>

			<PromptInput onSubmit={onSubmit} multiple>
				<PromptInputAttachments />
				<PromptInputTextarea placeholder="Type a message..." />
				<PromptInputFooter>
					<PromptInputTools>
						<AttachButton
							isPickerOpen={isPickerOpen}
							onOpenPicker={openFilePicker}
						/>
						<SearchToggleButton
							showSearch={showSearch}
							onToggle={toggleSearch}
						/>
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
