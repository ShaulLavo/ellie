import { useConfirm } from '@omit/react-confirm-dialog'
import type { StoredChatMessage } from '@/chat/types'
import type { SlashCommand } from '../components/slash-command-menu'
import {
	Trash2Icon,
	ListIcon,
	InfoIcon,
	DownloadIcon
} from 'lucide-react'
import { createElement } from 'react'
import { downloadTranscript } from '../utils/download-transcript'

interface UseChatCommandsOptions {
	branchId: string
	allMessages: StoredChatMessage[]
	onClear?: () => void
}

export function useChatCommands({
	branchId,
	allMessages,
	onClear
}: UseChatCommandsOptions) {
	const confirm = useConfirm()

	const handleDownloadTranscript = () => {
		downloadTranscript(allMessages, branchId)
	}

	const handleClearWithConfirm = async () => {
		const ok = await confirm({
			title: 'Clear conversation',
			description:
				'This will start a new conversation. Your current thread will be saved and can be resumed later.',
			confirmText: 'Clear',
			cancelText: 'Cancel'
		})
		if (ok) onClear?.()
	}

	const commands: SlashCommand[] = [
		{
			name: 'clear',
			description: 'Start a new conversation',
			icon: createElement(Trash2Icon, {
				className: 'size-4'
			}),
			action: () => handleClearWithConfirm()
		},
		{
			name: 'threads',
			description: 'List all threads',
			icon: createElement(ListIcon, {
				className: 'size-4'
			}),
			action: () => {
				/* TODO: thread list dialog */
			}
		},
		{
			name: 'info',
			description: 'Show thread info',
			icon: createElement(InfoIcon, {
				className: 'size-4'
			}),
			action: () => {
				/* TODO: branch info dialog */
			}
		},
		{
			name: 'transcript',
			description: 'Download transcript',
			icon: createElement(DownloadIcon, {
				className: 'size-4'
			}),
			action: handleDownloadTranscript
		}
	]

	return { commands }
}
