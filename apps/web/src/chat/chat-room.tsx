import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useChatDB } from './hooks/use-chat-db'
import { useTimeline } from './hooks/use-timeline'
import { useChatCommands } from './hooks/use-chat-commands'
import { useChatSubmit } from './hooks/use-chat-submit'
import { PromptInputProvider } from '@/components/ai-elements/prompt-input'
import { eden } from '@/lib/eden'
import { ChatToolbar } from './components/chat-toolbar'
import { ChatMessageList } from './components/chat-message-list'
import { SessionInfo } from './components/session-info'
import { SessionList } from './components/session-list'
import { PromptInputWithCommands } from './components/prompt-input-with-commands'

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
		timeline,
		allMessages,
		toolResults,
		consumedToolCallIds
	} = useTimeline(chat.messages, chat.streamingMessage)

	const { commands } = useChatCommands({
		sessionId,
		allMessages,
		onClear: onClear ?? chat.clearSession
	})

	const { handleSubmit } = useChatSubmit({
		commands,
		sendMessage: chat.sendMessage,
		speechRefRef
	})

	return (
		<div className="flex h-full w-full flex-col">
			<ChatToolbar
				onShowSessions={() => setShowSessionList(true)}
				onShowInfo={() => setShowSessionInfo(true)}
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

			<div className="relative flex flex-col flex-1 min-h-0">
				<ChatMessageList
					timeline={timeline}
					toolResults={toolResults}
					consumedToolCallIds={consumedToolCallIds}
					needsBootstrap={needsBootstrap}
					connectionState={chat.connectionState}
					connectionError={chat.error}
				/>
			</div>

			<div className="relative px-6 pb-5 pt-3">
				<div className="absolute inset-x-6 top-0 h-px bg-border/60" />
				<PromptInputProvider>
					<PromptInputWithCommands
						commands={commands}
						onSubmit={handleSubmit}
						disabled={chat.connectionState !== 'connected'}
						speechRefRef={speechRefRef}
						stats={chat.sessionStats}
					/>
				</PromptInputProvider>
			</div>
		</div>
	)
}
