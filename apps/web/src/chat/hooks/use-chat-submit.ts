import type { RefObject } from 'react'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import type { SlashCommand } from '../components/slash-command-menu'
import { matchSlashCommand } from '../utils'
import { uploadFiles } from '@/lib/upload'

export function useChatSubmit({
	commands,
	sendMessage,
	speechRefRef
}: {
	commands: SlashCommand[]
	sendMessage: (
		text: string,
		attachments?: {
			uploadId: string
			mime: string
			size: number
			name: string
		}[],
		speechRef?: string
	) => Promise<void>
	speechRefRef: RefObject<string | null>
}) {
	const handleSubmit = async (
		message: PromptInputMessage
	) => {
		const { text, files } = message
		if (!text.trim() && files.length === 0) return

		if (text.trim()) {
			const cmd = matchSlashCommand(text, commands)
			if (cmd) {
				cmd.action()
				return
			}
		}

		// Upload files via TUS before sending message
		const rawFiles = files
			.map(f => f.rawFile)
			.filter((f): f is File => f != null)
		const attachments =
			rawFiles.length > 0
				? await uploadFiles(rawFiles)
				: undefined

		const speechRef = speechRefRef.current
		speechRefRef.current = null
		await sendMessage(
			text,
			attachments,
			speechRef ?? undefined
		)
	}

	return { handleSubmit }
}
