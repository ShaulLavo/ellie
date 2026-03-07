import { useCallback, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useChatDB } from './hooks/use-chat-db'
import { useToolGrouping } from './hooks/use-tool-grouping'
import { useChatCommands } from './hooks/use-chat-commands'
import { PromptInputProvider } from '@/components/ai-elements/prompt-input'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import { eden } from '@/lib/eden'
import { uploadFiles } from '@/lib/upload'
import { ChatToolbar } from './components/chat-toolbar'
import { ChatMessageList } from './components/chat-message-list'
import { SessionStatusBar } from './components/session-status-bar'
import { SessionInfo } from './components/session-info'
import { SessionList } from './components/session-list'
import { ConnectionIndicator } from './components/connection-indicator'
import { ServerDownOverlay } from './components/server-down-overlay'
import { PromptInputWithCommands } from './components/prompt-input-with-commands'
import { matchSlashCommand } from './utils'

export function ChatRoom({
	sessionId,
	onClear
}: {
	sessionId: string
	onClear?: () => void
}) {
	const { data: status } = useQuery({
		queryKey: ['status'],
		queryFn: () => eden.api.status.get().then(r => r.data)
	})
	const needsBootstrap = status?.needsBootstrap ?? false

	const [showSessionList, setShowSessionList] =
		useState(false)
	const [showSessionInfo, setShowSessionInfo] =
		useState(false)

	const speechRefRef = useRef<string | null>(null)

	const chat = useChatDB(sessionId)

	const {
		allMessages,
		toolResults,
		consumedToolCallIds,
		hiddenMessageIds
	} = useToolGrouping(chat.messages, chat.streamingMessage)

	const { commands } = useChatCommands({
		sessionId,
		allMessages,
		onClear: onClear ?? chat.clearSession
	})

	const handleSubmit = useCallback(
		async (message: PromptInputMessage) => {
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
			await chat.sendMessage(
				text,
				attachments,
				speechRef ?? undefined
			)
		},
		[commands, chat]
	)

	return (
		<div className="flex h-full w-full flex-col">
			<ChatToolbar
				onShowSessions={() => setShowSessionList(true)}
				onShowInfo={() => setShowSessionInfo(true)}
			/>

			<ConnectionIndicator
				state={chat.connectionState}
				error={chat.error}
				onRetry={chat.retry}
			/>
			<ServerDownOverlay
				state={chat.connectionState}
				error={chat.error}
				onRetry={chat.retry}
			/>

			<SessionList
				open={showSessionList}
				onOpenChange={setShowSessionList}
				listSessions={() =>
					eden.chat.sessions.get().then(r => r.data)
				}
				onResume={async () => {}}
				currentSessionId={sessionId}
			/>
			<SessionInfo
				open={showSessionInfo}
				onOpenChange={setShowSessionInfo}
				getSessionStats={() =>
					eden.chat
						.sessions({ sessionId })
						.get()
						.then(r => r.data)
				}
			/>

			<ChatMessageList
				messages={chat.messages}
				streamingMessage={chat.streamingMessage}
				toolResults={toolResults}
				consumedToolCallIds={consumedToolCallIds}
				hiddenMessageIds={hiddenMessageIds}
				needsBootstrap={needsBootstrap}
			/>

			<div className="relative px-6 pb-5 pt-3">
				<div className="absolute inset-x-6 top-0 h-px bg-border/60" />
				<PromptInputProvider>
					<PromptInputWithCommands
						commands={commands}
						onSubmit={handleSubmit}
						disabled={chat.connectionState !== 'connected'}
						speechRefRef={speechRefRef}
					/>
				</PromptInputProvider>
			</div>

			<SessionStatusBar
				stats={chat.sessionStats}
				isAgentRunning={
					chat.isAgentRunning || !!chat.streamingMessage
				}
			/>
		</div>
	)
}
