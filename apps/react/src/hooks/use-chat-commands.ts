import { useMemo, useCallback } from 'react'
import { useConfirm } from '@omit/react-confirm-dialog'
import {
	messagesToTranscript,
	renderTranscript
} from '@ellie/schemas/chat'
import type { ChatMessage } from '@ellie/schemas/chat'
import type { SlashCommand } from '@/components/slash-command-menu'
import {
	Trash2Icon,
	ListIcon,
	InfoIcon,
	DownloadIcon
} from 'lucide-react'
import { createElement } from 'react'

interface UseChatCommandsOptions {
	sessionId: string
	allMessages: ChatMessage[]
	onClear?: () => void
}

export function useChatCommands({
	sessionId,
	allMessages,
	onClear
}: UseChatCommandsOptions) {
	const confirm = useConfirm()

	const handleDownloadTranscript = useCallback(() => {
		if (allMessages.length === 0) return

		const transcript = messagesToTranscript(allMessages)
		const text = renderTranscript(transcript)
		const blob = new Blob([text], { type: 'text/plain' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = `transcript-${sessionId}-${new Date().toISOString().slice(0, 10)}.txt`
		document.body.append(a)
		a.click()
		a.remove()
		URL.revokeObjectURL(url)
	}, [allMessages, sessionId])

	const handleClearWithConfirm = useCallback(async () => {
		const ok = await confirm({
			title: 'Clear conversation',
			description:
				'This will start a new conversation. Your current session will be saved and can be resumed later.',
			confirmText: 'Clear',
			cancelText: 'Cancel'
		})
		if (ok) onClear?.()
	}, [confirm, onClear])

	const commands = useMemo<SlashCommand[]>(
		() => [
			{
				name: 'clear',
				description: 'Start a new conversation',
				icon: createElement(Trash2Icon, {
					className: 'size-4'
				}),
				action: () => handleClearWithConfirm()
			},
			{
				name: 'sessions',
				description: 'List all sessions',
				icon: createElement(ListIcon, {
					className: 'size-4'
				}),
				action: () => {
					/* TODO: session list dialog */
				}
			},
			{
				name: 'info',
				description: 'Show current session info',
				icon: createElement(InfoIcon, {
					className: 'size-4'
				}),
				action: () => {
					/* TODO: session info dialog */
				}
			},
			{
				name: 'transcript',
				description: 'Download session transcript',
				icon: createElement(DownloadIcon, {
					className: 'size-4'
				}),
				action: handleDownloadTranscript
			}
		],
		[handleClearWithConfirm, handleDownloadTranscript]
	)

	return { commands }
}
