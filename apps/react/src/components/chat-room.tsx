// @ts-nocheck
import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon } from 'lucide-react'
import { useChatDB } from '../hooks/use-chat-db'
import { useToolGrouping } from '../hooks/use-tool-grouping'
import { useChatCommands } from '../hooks/use-chat-commands'
import { useSetupStatus } from '../hooks/use-setup-status'
import { useAgent } from '../hooks/use-agent-settings'
import { ChatMessage } from './chat-message'
import { AttachmentPreviews } from './attachment-previews'
import { ConnectionBadge } from './connection-badge'
import { TypingIndicator } from './typing-indicator'
import { ProgressIndicator } from './progress-indicator'
import { SlashCommandMenu } from './slash-command-menu'
import { AgentSettingsDialog } from './agent-settings-dialog'
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
	PromptInputActionMenu,
	PromptInputActionMenuTrigger,
	PromptInputActionMenuContent,
	PromptInputActionAddAttachments,
	usePromptInputController
} from '@/components/ai-elements/prompt-input'
import { Button } from '@/components/ui/button'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import type { SlashCommand } from './slash-command-menu'
import { SessionStatusBar } from './session-status-bar'
import { TreeView } from './tree-view'
import { SessionList } from './session-list'
import { SessionInfo } from './session-info'
import { SessionNameDialog } from './session-name-dialog'

const USERNAME = 'human'

function EmptyState() {
	return (
		<div className="flex size-full flex-col items-center justify-center gap-5 p-8">
			{/* Geometric orbital pattern */}
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
				{/* Orbiting dots */}
				<div className="absolute size-32 animate-orbit">
					<div className="absolute -top-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-primary/30" />
				</div>
				<div
					className="absolute size-16 animate-orbit"
					style={{ animationDuration: '8s' }}
				>
					<div className="absolute top-1/2 -right-0.5 size-1 -translate-y-1/2 rounded-full bg-primary/25" />
				</div>
				{/* Center glow */}
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

export function ChatRoom({
	feedId,
	onClear
}: {
	feedId: string
	onClear?: () => void
}) {
	const queryClient = useQueryClient()
	const onCredentialError = useCallback(() => {
		void queryClient.refetchQueries({
			queryKey: ['setup', 'status']
		})
	}, [queryClient])
	const chat = useChatDB(
		feedId,
		USERNAME,
		onCredentialError
	)
	const [modelPickerOpen, setModelPickerOpen] =
		useState(false)
	const { data: setupStatus } = useSetupStatus()
	const agentId = setupStatus?.agents?.[0]?.id

	const {
		allMessages,
		toolResults,
		consumedToolCallIds,
		hiddenMessageIds
	} = useToolGrouping(chat.messages, chat.streamingMessage)

	const { commands, dialogs } = useChatCommands({
		feedId,
		allMessages,
		onClear,
		forkSession: chat.forkSession
	})

	const handleSubmit = async (
		message: PromptInputMessage
	) => {
		const { text, files } = message
		if (!text.trim() && files.length === 0) return

		// Handle slash commands
		const trimmed = text.trim()
		if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
			const cmd = commands.find(
				c => `/${c.name}` === trimmed
			)
			if (cmd) {
				cmd.action()
				return
			}
		}

		if (files.length > 0) {
			let fileObjects: File[]
			try {
				fileObjects = await Promise.all(
					files
						.filter(f => f.url)
						.map(async f => {
							const res = await fetch(f.url!)
							const blob = await res.blob()
							return new File(
								[blob],
								f.filename ?? 'file',
								{ type: f.mediaType }
							)
						})
				)
			} catch (err) {
				console.error('[chat] File conversion failed:', err)
				return
			}
			await chat.sendWithFiles(text, fileObjects, USERNAME)
		} else {
			await chat.sendMessage(text, USERNAME)
		}
	}

	return (
		<div className="flex h-full flex-col">
			{(chat.error ||
				chat.connectionState !== 'connected') && (
				<div className="flex items-center gap-2 px-5 py-1.5 border-b border-border/60">
					<ConnectionBadge
						state={chat.connectionState}
						onRetry={chat.retry}
					/>
					{chat.error && (
						<span className="text-[11px] text-destructive">
							{chat.error}
						</span>
					)}
				</div>
			)}

			<Conversation className="flex-1">
				<ConversationContent className="gap-5 px-6 py-5">
					{chat.hasMore && (
						<div className="flex justify-center py-1">
							<Button
								variant="ghost"
								size="sm"
								onClick={chat.loadMore}
								className="text-xs text-muted-foreground hover:text-foreground h-7"
							>
								Load older messages
							</Button>
						</div>
					)}
					{chat.messages.length === 0 &&
					!chat.streamingMessage ? (
						<EmptyState />
					) : (
						<>
							{chat.messages.map(msg =>
								hiddenMessageIds.has(msg.id) ? null : (
									<ChatMessage
										key={msg.id}
										message={msg}
										feedId={feedId}
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
									<ChatMessage
										key={chat.streamingMessage.id}
										message={chat.streamingMessage}
										feedId={feedId}
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

			<TypingIndicator
				typingUsers={chat.typingUsers}
				agentStatus={chat.agentStatus}
			/>
			<ProgressIndicator
				activeProgress={chat.activeProgress}
			/>

			{/* Prompt area */}
			<div className="relative px-6 pb-5 pt-3">
				<div className="absolute inset-x-6 top-0 h-px bg-border/60" />
				<PromptInputProvider>
					<PromptInputWithCommands
						commands={commands}
						onSubmit={handleSubmit}
						onTyping={() => chat.notifyTyping(USERNAME)}
						disabled={chat.connectionState !== 'connected'}
						agentId={agentId}
						onOpenModelPicker={() =>
							setModelPickerOpen(true)
						}
					/>
				</PromptInputProvider>
			</div>

			<AgentSettingsDialog
				open={modelPickerOpen}
				onOpenChange={setModelPickerOpen}
				agentId={agentId}
			/>
			<SessionStatusBar
				sessionInfo={chat.sessionInfo}
				agentStatus={chat.agentStatus}
			/>

			{/* Session management dialogs */}
			<TreeView
				open={dialogs.showTree}
				onOpenChange={dialogs.setShowTree}
				getTree={chat.getTree}
				onBranchSwitch={chat.switchBranch}
			/>
			<SessionList
				open={dialogs.showSessions}
				onOpenChange={dialogs.setShowSessions}
				listSessions={chat.listSessions}
				onResume={chat.resumeSession}
			/>
			<SessionInfo
				open={dialogs.showSessionInfo}
				onOpenChange={dialogs.setShowSessionInfo}
				getSessionStats={chat.getSessionStats}
			/>
			<SessionNameDialog
				open={dialogs.showNameDialog}
				onOpenChange={dialogs.setShowNameDialog}
				onName={chat.nameSession}
			/>
		</div>
	)
}

function PromptInputWithCommands({
	commands,
	onSubmit,
	onTyping,
	disabled,
	agentId,
	onOpenModelPicker
}: {
	commands: SlashCommand[]
	onSubmit: (message: PromptInputMessage) => void
	onTyping: () => void
	disabled: boolean
	agentId: string | undefined
	onOpenModelPicker: () => void
}) {
	const controller = usePromptInputController()
	const inputValue = controller.textInput.value
	const { data: agent } = useAgent(agentId)

	const handleCommandSelect = (cmd: SlashCommand) => {
		controller.textInput.clear()
		cmd.action()
	}

	// Derive a short display name from the model id, e.g. "claude-sonnet-4-6" → "Sonnet 4.6"
	const modelLabel = agent?.model
		? agent.model
				.replace(/^claude-/, '')
				.replace(/-(\d{8})$/, '')
				.split('-')
				.map(w => w.charAt(0).toUpperCase() + w.slice(1))
				.join(' ')
		: null

	return (
		<div className="relative">
			<SlashCommandMenu
				commands={commands}
				inputValue={inputValue}
				onSelect={handleCommandSelect}
			/>
			<PromptInput onSubmit={onSubmit} multiple>
				<AttachmentPreviews />
				<PromptInputTextarea
					placeholder="Type a message..."
					onChange={onTyping}
				/>
				<PromptInputFooter>
					<PromptInputTools>
						{modelLabel && (
							<button
								type="button"
								onClick={onOpenModelPicker}
								className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							>
								{modelLabel}
								<ChevronDownIcon className="size-3 opacity-60" />
							</button>
						)}
						<PromptInputActionMenu>
							<PromptInputActionMenuTrigger />
							<PromptInputActionMenuContent>
								<PromptInputActionAddAttachments />
							</PromptInputActionMenuContent>
						</PromptInputActionMenu>
					</PromptInputTools>
					<PromptInputSubmit disabled={disabled} />
				</PromptInputFooter>
			</PromptInput>
		</div>
	)
}
