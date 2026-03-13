import type { ContentPart } from '@ellie/schemas/chat'
import type { ConnectionState } from '@ellie/schemas/chat'
import type { SlashCommand } from './components/slash-command-menu'

export type ToolResultPart = Extract<
	ContentPart,
	{ type: 'tool-result' }
>

/**
 * Try to match input text against a slash command.
 * Returns the matched command, or undefined if no match.
 */
export function matchSlashCommand(
	text: string,
	commands: SlashCommand[]
): SlashCommand | undefined {
	const trimmed = text.trim()
	if (!trimmed.startsWith('/') || trimmed.includes(' '))
		return undefined
	return commands.find(c => `/${c.name}` === trimmed)
}

export function formatTime(iso: string): string {
	return new Date(iso).toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit'
	})
}

export function formatModel(model: string): string {
	const match = model.match(/^claude-(.+?)(-\d{8})?$/)
	return match ? match[1] : model
}

export function getEmptyStateContent(
	connectionState: ConnectionState,
	needsBootstrap: boolean
) {
	if (
		connectionState === 'error' ||
		connectionState === 'disconnected'
	) {
		return {
			title: 'Server Unreachable',
			description: 'Attempting to reconnect...'
		}
	}
	if (needsBootstrap) {
		return {
			title: 'Say hi to your agent',
			description: 'Send your first message to get started.'
		}
	}
	return {
		title: 'Start a conversation',
		description: 'Send a message below to begin.'
	}
}
