import {
	useCallback,
	useMemo,
	useRef,
	useState,
	type ClipboardEvent
} from 'react'
import { cn } from './lib/utils'
import { useAgentChat } from './lib/chat/use-agent-chat'
import type { Message } from './lib/chat/use-chat'
import { useHotkey } from '@tanstack/react-hotkeys'
import {
	resolveSelectedMarkdown,
	setMarkdownClipboardData,
	writeMarkdownToSystemClipboard
} from './lib/chat/markdown-copy'
import { Chat } from './components/chat/chat'
import {
	ChatHeader,
	ChatHeaderAddon,
	ChatHeaderAvatar,
	ChatHeaderButton,
	ChatHeaderMain
} from './components/chat/chat-header'
import { ChatMessages } from './components/chat/chat-messages'
import {
	ChatToolbar,
	ChatToolbarAddon,
	ChatToolbarButton,
	ChatToolbarTextarea
} from './components/chat/chat-toolbar'
import {
	ChatEvent,
	ChatEventAddon,
	ChatEventAvatar,
	ChatEventBody,
	ChatEventContent,
	ChatEventTime,
	ChatEventTitle
} from './components/chat/chat-event'
import { MessageResponse } from './components/ai-elements/message'
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger
} from './components/ai-elements/reasoning'
import { ToolCard } from './components/ai-elements/tool'
import { Shimmer } from './components/ai-elements/shimmer'
import { Separator } from './components/ui/separator'
import { Spinner } from './components/ui/spinner'
import {
	ArrowUp,
	Moon,
	Paperclip,
	Sun,
	Robot,
	User,
	Monitor,
	Stop
} from '@phosphor-icons/react'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger
} from './components/ui/dropdown-menu'
import { useTheme } from './hooks/use-theme'

// ============================================================================
// Types
// ============================================================================

interface TextPart {
	type: 'text'
	text: string
}

interface ThinkingPart {
	type: 'thinking'
	thinking: string
}

interface ToolCallPart {
	type: 'toolCall'
	id: string
	name: string
	arguments: Record<string, unknown>
}

type ContentPart = TextPart | ThinkingPart | ToolCallPart

interface ToolResultInfo {
	toolName: string
	result: string
	isError: boolean
}

// ============================================================================
// Helpers
// ============================================================================

function getContentParts(msg: Message): ContentPart[] {
	if (!msg.content || !Array.isArray(msg.content)) return []
	return msg.content as ContentPart[]
}

function getTextContent(msg: Message): string {
	return getContentParts(msg)
		.filter((c): c is TextPart => c.type === 'text')
		.map(c => c.text)
		.join('')
}

function isToolResultMsg(msg: Message): boolean {
	return msg.role === 'toolResult'
}

function buildToolResultMap(
	messages: Message[]
): Map<string, ToolResultInfo> {
	const map = new Map<string, ToolResultInfo>()
	for (const msg of messages) {
		if (msg.role === 'toolResult') {
			const toolCallId = msg.toolCallId as string
			const toolName =
				(msg.toolName as string) ?? 'unknown'
			const content = msg.content as Array<{
				type: string
				text?: string
			}>
			const resultText =
				content
					?.filter(c => c.type === 'text')
					.map(c => c.text ?? '')
					.join('') ?? ''
			const isError = (msg.isError as boolean) ?? false
			map.set(toolCallId, {
				toolName,
				result: resultText,
				isError
			})
		}
	}
	return map
}

function getMsgKey(msg: Message, idx: number): string {
	return `${msg.role}-${msg.timestamp}-${idx}`
}

function groupMessages(messages: Message[]) {
	const displayMessages = messages.filter(
		m => !isToolResultMsg(m)
	)

	const groups: Array<{ msg: Message; isFirst: boolean }> =
		[]
	for (let i = 0; i < displayMessages.length; i++) {
		const msg = displayMessages[i]
		const prev = displayMessages[i - 1]
		const isFirst =
			!prev ||
			prev.role !== msg.role ||
			msg.timestamp - prev.timestamp > 5 * 60 * 1000
		groups.push({ msg, isFirst })
	}
	return groups
}

// ============================================================================
// Sub-components
// ============================================================================

function ModeToggle() {
	const { setPreference } = useTheme()
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<ChatHeaderButton title="Toggle theme" />}
			>
				<Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
				<Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
				<span className="sr-only">Toggle theme</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem
					onClick={() => setPreference('light')}
				>
					<Sun className="size-4" />
					Light
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => setPreference('dark')}
				>
					<Moon className="size-4" />
					Dark
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => setPreference('system')}
				>
					<Monitor className="size-4" />
					System
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function AssistantMessageContent({
	msg,
	toolResultMap
}: {
	msg: Message
	toolResultMap: Map<string, ToolResultInfo>
}) {
	const parts = getContentParts(msg)
	const thinkingParts = parts.filter(
		(p): p is ThinkingPart => p.type === 'thinking'
	)
	const textParts = parts.filter(
		(p): p is TextPart => p.type === 'text'
	)
	const toolCallParts = parts.filter(
		(p): p is ToolCallPart => p.type === 'toolCall'
	)
	const textContent = textParts.map(p => p.text).join('')

	return (
		<div className="flex flex-col gap-2">
			{thinkingParts.map((part, i) => (
				<Reasoning
					key={`thinking-${i}`}
					isStreaming={false}
					defaultOpen={false}
				>
					<ReasoningTrigger />
					<ReasoningContent>
						{part.thinking}
					</ReasoningContent>
				</Reasoning>
			))}

			{textContent && (
				<MessageResponse>{textContent}</MessageResponse>
			)}

			{toolCallParts.map(part => {
				const result = toolResultMap.get(part.id)
				return (
					<ToolCard
						key={part.id}
						name={part.name}
						args={part.arguments}
						result={result?.result}
						isError={result?.isError}
					/>
				)
			})}
		</div>
	)
}

function UserMessageContent({ msg }: { msg: Message }) {
	const textContent = getTextContent(msg)
	if (!textContent) return null
	return <MessageResponse>{textContent}</MessageResponse>
}

// ============================================================================
// Main Panel
// ============================================================================

interface AIChatPanelProps {
	sessionId: string
}

export function AIChatPanel({ sessionId }: AIChatPanelProps) {
	const {
		messages,
		isLoading,
		isSending,
		error,
		sendMessage,
		abort
	} = useAgentChat(sessionId)
	const [input, setInput] = useState('')
	const messagesRef = useRef<HTMLDivElement>(null)

	const handleSubmit = useCallback(() => {
		const text = input.trim()
		if (!text) return
		setInput('')
		void sendMessage(text)
	}, [input, sendMessage])

	const handleAbort = useCallback(() => {
		void abort()
	}, [abort])

	const toolResultMap = useMemo(
		() => buildToolResultMap(messages),
		[messages]
	)

	const grouped = useMemo(
		() => groupMessages(messages),
		[messages]
	)

	const displayMessageCount = useMemo(
		() => messages.filter(m => !isToolResultMsg(m)).length,
		[messages]
	)

	const isAgentWorking = useMemo(() => {
		if (isSending) return true
		if (messages.length === 0) return false
		const last = messages[messages.length - 1]
		if (last.role === 'user') return true
		if (last.role === 'toolResult') return true
		if (
			last.role === 'assistant' &&
			last.stopReason === 'toolUse'
		)
			return true
		return false
	}, [messages, isSending])

	// ── Markdown copy support ────────────────────────────
	const messageOrder = useMemo(
		() =>
			grouped.map((_item, idx) =>
				getMsgKey(_item.msg, idx)
			),
		[grouped]
	)

	const markdownById = useMemo(() => {
		const map = new Map<string, string>()
		for (let i = 0; i < grouped.length; i++) {
			const { msg } = grouped[i]
			map.set(getMsgKey(msg, i), getTextContent(msg))
		}
		return map
	}, [grouped])

	const getSelectedMarkdown = useCallback(
		() =>
			resolveSelectedMarkdown({
				container: messagesRef.current,
				messageOrder,
				markdownById
			}),
		[markdownById, messageOrder]
	)

	const handleHotkeyCopy = useCallback(async () => {
		const markdown = getSelectedMarkdown()
		if (!markdown) return
		try {
			await writeMarkdownToSystemClipboard(markdown)
		} catch (err) {
			console.error(
				'[AIChatPanel] Clipboard write failed:',
				err instanceof Error
					? err.message
					: JSON.stringify(err)
			)
		}
	}, [getSelectedMarkdown])

	useHotkey(
		'Mod+C',
		() => {
			void handleHotkeyCopy()
		},
		{
			target: messagesRef,
			eventType: 'keydown',
			preventDefault: true,
			stopPropagation: true
		}
	)

	const handleMessagesCopy = useCallback(
		(event: ClipboardEvent<HTMLDivElement>) => {
			const markdown = getSelectedMarkdown()
			if (!markdown) return
			event.preventDefault()
			setMarkdownClipboardData(
				event.clipboardData,
				markdown
			)
		},
		[getSelectedMarkdown]
	)

	// ── Derive whether the thinking indicator needs its own avatar ──
	const lastGroupedRole =
		grouped.length > 0
			? grouped[grouped.length - 1].msg.role
			: null
	const thinkingNeedsAvatar = lastGroupedRole !== 'assistant'

	return (
		<Chat className="flex-1 min-w-0">
			{/* ── Header ─────────────────────────────────────── */}
			<ChatHeader className="border-b">
				<ChatHeaderAddon data-chat-meta>
					<ChatHeaderAvatar
						fallback={
							<Robot
								weight="fill"
								className="size-3.5"
							/>
						}
						className="bg-primary text-primary-foreground"
					/>
				</ChatHeaderAddon>
				<ChatHeaderMain>
					<div className="grid" data-chat-meta>
						<span className="text-sm font-semibold leading-tight truncate">
							Agent
						</span>
						<span className="text-xs text-muted-foreground leading-tight">
							{isLoading
								? 'connecting…'
								: isAgentWorking
									? 'thinking…'
									: `${displayMessageCount} message${displayMessageCount !== 1 ? 's' : ''}`}
						</span>
					</div>
				</ChatHeaderMain>
				<ChatHeaderAddon>
					{isLoading && (
						<Spinner className="size-4 text-muted-foreground" />
					)}
					<ModeToggle />
				</ChatHeaderAddon>
			</ChatHeader>

			{/* ── Messages ───────────────────────────────────── */}
			<ChatMessages
				ref={messagesRef}
				onCopy={handleMessagesCopy}
			>
				{error && (
					<p className="mx-4 my-2 text-xs text-destructive">
						{error.message}
					</p>
				)}

				{!isLoading && messages.length === 0 && (
					<div className="flex-1 flex items-center justify-center">
						<p className="text-sm text-muted-foreground">
							No messages yet
						</p>
					</div>
				)}

				<div className="flex flex-col py-2">
					{grouped.map(({ msg, isFirst }, idx) => {
						const isUser = msg.role === 'user'
						const isAssistant =
							msg.role === 'assistant'
						const msgKey = getMsgKey(msg, idx)
						const timestamp = new Date(
							msg.timestamp
						).toISOString()

						const prev = grouped[idx - 1]?.msg
						const showDateSep =
							prev &&
							new Date(
								msg.timestamp
							).toDateString() !==
								new Date(
									prev.timestamp
								).toDateString()

						return (
							<div
								key={msgKey}
								data-chat-message-id={msgKey}
							>
								{showDateSep && (
									<ChatEvent
										className="items-center gap-1 my-4"
										data-chat-meta
									>
										<Separator className="flex-1" />
										<ChatEventTime
											timestamp={
												timestamp
											}
											format="longDate"
											className="text-xs text-muted-foreground font-semibold min-w-max"
											data-chat-meta
										/>
										<Separator className="flex-1" />
									</ChatEvent>
								)}

								<ChatEvent
									className={cn(
										'group hover:bg-accent transition-colors py-0.5',
										isFirst &&
											idx > 0 &&
											!showDateSep &&
											'mt-3'
									)}
								>
									<ChatEventAddon
										className={
											isFirst
												? ''
												: 'pt-0 items-center'
										}
										data-chat-meta
									>
										{isFirst ? (
											<ChatEventAvatar
												fallback={
													isUser ? (
														<User
															weight="fill"
															className="size-3.5"
														/>
													) : (
														<Robot
															weight="fill"
															className="size-3.5"
														/>
													)
												}
												className={cn(
													'size-7 @md/chat:size-8',
													isAssistant
														? 'bg-primary text-primary-foreground'
														: 'bg-secondary text-secondary-foreground'
												)}
											/>
										) : (
											<ChatEventTime
												timestamp={
													timestamp
												}
												format="time"
												className="text-right text-[10px] leading-tight opacity-0 group-hover:opacity-100 transition-opacity duration-150 w-full text-muted-foreground/50"
												data-chat-meta
											/>
										)}
									</ChatEventAddon>

									<ChatEventBody>
										{isFirst && (
											<ChatEventTitle
												data-chat-meta
											>
												<span className="font-medium">
													{isAssistant
														? 'Agent'
														: 'You'}
												</span>
												<ChatEventTime
													timestamp={
														timestamp
													}
													className="text-[10px] text-muted-foreground/50"
													data-chat-meta
												/>
											</ChatEventTitle>
										)}
										<ChatEventContent className="text-sm">
											{isAssistant ? (
												<AssistantMessageContent
													msg={msg}
													toolResultMap={
														toolResultMap
													}
												/>
											) : (
												<UserMessageContent
													msg={msg}
												/>
											)}
										</ChatEventContent>
									</ChatEventBody>
								</ChatEvent>
							</div>
						)
					})}

					{/* ── Thinking indicator ──────────────── */}
					{isAgentWorking && !isLoading && (
						<ChatEvent className="group py-0.5 mt-1">
							<ChatEventAddon
								className={
									thinkingNeedsAvatar
										? ''
										: 'pt-0 items-center'
								}
								data-chat-meta
							>
								{thinkingNeedsAvatar ? (
									<ChatEventAvatar
										fallback={
											<Robot
												weight="fill"
												className="size-3.5"
											/>
										}
										className="size-7 @md/chat:size-8 bg-primary text-primary-foreground"
									/>
								) : (
									<div className="w-full" />
								)}
							</ChatEventAddon>
							<ChatEventBody>
								{thinkingNeedsAvatar && (
									<ChatEventTitle
										data-chat-meta
									>
										<span className="font-medium">
											Agent
										</span>
									</ChatEventTitle>
								)}
								<ChatEventContent className="text-sm">
									<Shimmer duration={1.5}>
										Thinking…
									</Shimmer>
								</ChatEventContent>
							</ChatEventBody>
						</ChatEvent>
					)}
				</div>
			</ChatMessages>

			{/* ── Toolbar ────────────────────────────────────── */}
			<ChatToolbar>
				<ChatToolbarAddon align="inline-start">
					<ChatToolbarButton
						title="Attach"
						className="rounded-full size-7"
					>
						<Paperclip className="size-4" />
					</ChatToolbarButton>
				</ChatToolbarAddon>
				<ChatToolbarTextarea
					value={input}
					onChange={e => setInput(e.target.value)}
					onSubmit={handleSubmit}
					placeholder="Message…"
					disabled={isLoading}
				/>
				<ChatToolbarAddon align="inline-end">
					{isAgentWorking ? (
						<ChatToolbarButton
							onClick={handleAbort}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90 size-7 rounded-full"
							title="Stop"
						>
							<Stop
								weight="fill"
								className="size-3.5"
							/>
						</ChatToolbarButton>
					) : (
						<ChatToolbarButton
							onClick={handleSubmit}
							disabled={
								isLoading || !input.trim()
							}
							className="bg-primary text-primary-foreground hover:bg-primary/90 size-7 rounded-full"
							title="Send"
						>
							<ArrowUp
								weight="bold"
								className="size-3.5"
							/>
						</ChatToolbarButton>
					)}
				</ChatToolbarAddon>
			</ChatToolbar>
		</Chat>
	)
}
