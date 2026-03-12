import { AILoader } from '@/components/ai-loader'
import type { ConnectionState } from '@ellie/schemas/chat'

function EmptyStateText({
	title,
	description
}: {
	title: string
	description: string
}) {
	return (
		<>
			<h3 className="font-display text-sm font-semibold tracking-tight text-foreground/80">
				{title}
			</h3>
			<p className="text-[13px] text-muted-foreground/70">
				{description}
			</p>
		</>
	)
}

function getEmptyStateContent(
	connectionState: ConnectionState,
	needsBootstrap: boolean
) {
	if (connectionState !== 'connected') {
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

export function EmptyState({
	needsBootstrap,
	connectionState
}: {
	needsBootstrap: boolean
	connectionState: ConnectionState
}) {
	const { title, description } = getEmptyStateContent(
		connectionState,
		needsBootstrap
	)

	return (
		<div className="flex size-full flex-col items-center justify-center gap-5 p-8">
			<AILoader className="size-16" />
			<div className="space-y-1 text-center">
				<EmptyStateText
					title={title}
					description={description}
				/>
			</div>
		</div>
	)
}
