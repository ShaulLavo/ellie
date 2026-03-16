import { useEffect, useState, type RefObject } from 'react'
import { usePromptInputController } from '@/components/ai-elements/prompt-input'
import { useFileDragOver } from '../../hooks/use-file-drag-over'
import { transcribeAudio } from '@/lib/speech-client'
import type { SlashCommand } from '../components/slash-command-menu'

export function usePromptInputLogic(
	speechRefRef?: RefObject<string | null>
) {
	const controller = usePromptInputController()
	const inputValue = controller.textInput.value
	const [showSearch, setShowSearch] = useState(false)
	const [isPickerOpen, setIsPickerOpen] = useState(false)
	const isFileDragging = useFileDragOver()

	// Detect when the native file picker closes via window re-focus
	useEffect(() => {
		if (!isPickerOpen) return
		const handleFocus = () => setIsPickerOpen(false)
		window.addEventListener('focus', handleFocus)
		return () =>
			window.removeEventListener('focus', handleFocus)
	}, [isPickerOpen])

	const handleAudioRecorded = async (audioBlob: Blob) => {
		try {
			const result = await transcribeAudio(audioBlob)
			// eslint-disable-next-line react-compiler/react-compiler -- writing to a passed-in ref is intentional
			if (speechRefRef)
				speechRefRef.current = result.speechRef
			return result.text
		} catch (err) {
			console.error(
				'[PromptInput] Transcription failed:',
				err instanceof Error ? err.message : String(err)
			)
			return ''
		}
	}

	const handleTranscriptionChange = (text: string) => {
		controller.textInput.setInput(text)
	}

	const handleCommandSelect = (cmd: SlashCommand) => {
		controller.textInput.clear()
		cmd.action()
	}

	const openFilePicker = () => {
		setIsPickerOpen(true)
		controller.attachments.openFileDialog()
	}

	const toggleSearch = () => setShowSearch(!showSearch)

	const addFiles = (files: File[]) =>
		controller.attachments.add(files)

	return {
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
	}
}
