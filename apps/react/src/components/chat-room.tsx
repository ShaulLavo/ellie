import { useCallback } from 'react'
import { useChatDB } from '../hooks/use-chat-db'
import { useToolGrouping } from '../hooks/use-tool-grouping'
import { useChatCommands } from '../hooks/use-chat-commands'
import { SlashCommandMenu } from './slash-command-menu'
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton
} from '@/components/ai-elements/conversation'
import {
	PromptInput,
	PromptInputProvider,
	PromptInputTextarea,
	PromptInputFooter,
	PromptInputTools,
	PromptInputSubmit,
	usePromptInputController
} from '@/components/ai-elements/prompt-input'
import { ChatMessageRow } from './chat-message'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import type { SlashCommand } from './slash-command-menu'
import {
	WifiOffIcon,
	Loader2Icon,
	AlertCircleIcon
} from 'lucide-react'
import type { ConnectionState } from '@ellie/schemas/chat'
import { SessionStatusBar } from './chat/session-status-bar'

function EmptyState() {
	return (
		<div className="flex size-full flex-col items-center justify-center gap-5 p-8">
			<div className="relative flex items-center justify-center">
				<div className="absolute size-32 rounded-full border border-primary/5 animate-orbit" />
				<div
					className="absolute size-24 rounded-full border border-primary/8"
					style={{
						animation: 'orbit 18s linear infinite reverse'
					}}
				/>
				<div
					className="absolute size-16 rounded-full border border-primary/10 animate-orbit"
					style={{ animationDuration: '8s' }}
				/>
				<div className="absolute size-32 animate-orbit">
					<div className="absolute -top-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-primary/30" />
				</div>
				<div
					className="absolute size-16 animate-orbit"
					style={{ animationDuration: '8s' }}
				>
					<div className="absolute top-1/2 -right-0.5 size-1 -translate-y-1/2 rounded-full bg-primary/25" />
				</div>
				<div className="relative size-9 rounded-full bg-primary/[0.06] flex items-center justify-center">
					<div className="size-3.5 rounded-full bg-primary/15 animate-glow-pulse" />
				</div>
			</div>
			<div className="space-y-1 text-center">
				<h3 className="font-display text-sm font-semibold tracking-tight text-foreground/80">
					Start a conversation
				</h3>
				<p className="text-[13px] text-muted-foreground/70">
					Send a message below to begin.
				</p>
			</div>
		</div>
	)
}

function ConnectionIndicator({
	state,
	error,
	onRetry
}: {
	state: ConnectionState
	error: string | null
	onRetry: () => void
}) {
	if (state === 'connected' && !error) return null

	return (
		<div className="flex items-center gap-2 px-5 py-1.5 border-b border-border/60">
			{state === 'connecting' && (
				<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<Loader2Icon className="size-3 animate-spin" />
					Connecting...
				</span>
			)}
			{state === 'disconnected' && (
				<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<WifiOffIcon className="size-3" />
					Disconnected
				</span>
			)}
			{state === 'error' && (
				<button
					type="button"
					onClick={onRetry}
					className="flex items-center gap-1.5 text-[11px] text-destructive hover:underline"
				>
					<AlertCircleIcon className="size-3" />
					Connection error — click to retry
				</button>
			)}
			{error && (
				<span className="text-[11px] text-destructive">
					{error}
				</span>
			)}
		</div>
	)
}

export function ChatRoom({
	sessionId,
	onClear
}: {
	sessionId: string
	onClear?: () => void
}) {
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
			const { text } = message
			if (!text.trim()) return

			// Handle slash commands
			const trimmed = text.trim()
			if (
				trimmed.startsWith('/') &&
				!trimmed.includes(' ')
			) {
				const cmd = commands.find(
					c => `/${c.name}` === trimmed
				)
				if (cmd) {
					cmd.action()
					return
				}
			}

			await chat.sendMessage(text)
		},
		[commands, chat.sendMessage]
	)

	return (
		<div className="flex h-full flex-col">
			<ConnectionIndicator
				state={chat.connectionState}
				error={chat.error}
				onRetry={chat.retry}
			/>

			<Conversation className="flex-1">
				<ConversationContent className="gap-5 px-6 py-5">
					{chat.messages.length === 0 &&
					!chat.streamingMessage ? (
						<EmptyState />
					) : (
						<>
							{chat.messages.map(msg =>
								hiddenMessageIds.has(msg.id) ? null : (
									<ChatMessageRow
										key={msg.id}
										message={msg}
										toolResults={toolResults}
										consumedToolCallIds={
											consumedToolCallIds
										}
									/>
								)
							)}
							{chat.streamingMessage &&
								!hiddenMessageIds.has(
									chat.streamingMessage.id
								) && (
									<ChatMessageRow
										key={chat.streamingMessage.id}
										message={chat.streamingMessage}
										toolResults={toolResults}
										consumedToolCallIds={
											consumedToolCallIds
										}
									/>
								)}
						</>
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>

			{/* Prompt area */}
			<div className="relative px-6 pb-5 pt-3">
				<div className="absolute inset-x-6 top-0 h-px bg-border/60" />
				<PromptInputProvider>
					<PromptInputWithCommands
						commands={commands}
						onSubmit={handleSubmit}
						disabled={chat.connectionState !== 'connected'}
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

function PromptInputWithCommands({
	commands,
	onSubmit,
	disabled
}: {
	commands: SlashCommand[]
	onSubmit: (message: PromptInputMessage) => void
	disabled: boolean
}) {
	const controller = usePromptInputController()
	const inputValue = controller.textInput.value

	const handleCommandSelect = (cmd: SlashCommand) => {
		controller.textInput.clear()
		cmd.action()
	}

	return (
		<div className="relative">
			<SlashCommandMenu
				commands={commands}
				inputValue={inputValue}
				onSelect={handleCommandSelect}
			/>
			<PromptInput onSubmit={onSubmit}>
				<PromptInputTextarea placeholder="Type a message..." />
				<PromptInputFooter>
					<PromptInputTools />
					<PromptInputSubmit disabled={disabled} />
				</PromptInputFooter>
			</PromptInput>
		</div>
	)
}
