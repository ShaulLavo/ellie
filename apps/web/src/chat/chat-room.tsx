import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useChatDB } from './hooks/use-chat-db'
import { useTimeline } from './hooks/use-timeline'
import { useChatCommands } from './hooks/use-chat-commands'
import { useChatSubmit } from './hooks/use-chat-submit'
import { PromptInputProvider } from '@/components/ai-elements/prompt-input'
import { eden } from '@/lib/eden'
// import { ChatToolbar } from './components/chat-toolbar'
import { ChatMessageList } from './components/chat-message-list'
import { BranchInfo } from './components/branch-info'
import { ThreadList } from './components/thread-list'
import { PromptInputWithCommands } from './components/prompt-input-with-commands'

export function ChatRoom({
	branchId,
	onClear
}: {
	branchId: string
	onClear?: () => void
}) {
	const { data: status } = useQuery({
		queryKey: ['status'],
		queryFn: () => eden.api.status.get().then(r => r.data)
	})
	const needsBootstrap = status?.needsBootstrap ?? false

	const [showThreadList, setShowThreadList] =
		useState(false)
	const [showBranchInfo, setShowBranchInfo] =
		useState(false)

	const speechRefRef = useRef<string | null>(null)

	const chat = useChatDB(branchId)

	const {
		timeline,
		allMessages,
		toolResults,
		consumedToolCallIds
	} = useTimeline(chat.messages, chat.streamingMessage)

	const { commands } = useChatCommands({
		branchId,
		allMessages,
		onClear: onClear ?? chat.clearBranch
	})

	const { handleSubmit } = useChatSubmit({
		commands,
		sendMessage: chat.sendMessage,
		speechRefRef
	})

	return (
		<div className="flex h-full w-full flex-col">
			{/* <ChatToolbar
				onShowThreads={() => setShowThreadList(true)}
				onShowInfo={() => setShowBranchInfo(true)}
			/> */}

			<ThreadList
				open={showThreadList}
				onOpenChange={setShowThreadList}
				listThreads={() =>
					eden.api.threads.get().then(r => r.data)
				}
				onResume={async () => {}}
				currentThreadId={branchId}
			/>
			<BranchInfo
				open={showBranchInfo}
				onOpenChange={setShowBranchInfo}
				getBranchStats={() =>
					eden.api.chat
						.branches({ branchId })
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

			<div className="relative px-6 pb-4 pt-3">
				<div className="absolute inset-x-6 top-0 h-px bg-border/60" />
				<PromptInputProvider>
					<PromptInputWithCommands
						commands={commands}
						onSubmit={handleSubmit}
						disabled={chat.connectionState !== 'connected'}
						speechRefRef={speechRefRef}
						stats={chat.branchStats}
					/>
				</PromptInputProvider>
			</div>
		</div>
	)
}
