import { memo, useEffect, useRef, useState } from 'react'
import {
	CopyIcon,
	CheckIcon,
	BookOpenIcon
} from 'lucide-react'
import type {
	ChatMessage as ChatMessageType,
	ContentPart
} from '@ellie/schemas/chat'
import {
	Message,
	MessageContent,
	MessageResponse,
	StreamingMessageResponse,
	MessageActions,
	MessageAction
} from '@/components/ai-elements/message'
import {
	Reasoning,
	ReasoningTrigger,
	ReasoningContent
} from '@/components/ai-elements/reasoning'
import { ToolCard } from '@/components/ai-elements/tool'

type ToolResultPart = Extract<
	ContentPart,
	{ type: 'tool-result' }
>

const PartRenderer = memo(function PartRenderer({
	part,
	isStreaming,
	toolResults,
	consumedToolCallIds
}: {
	part: ContentPart
	isStreaming?: boolean
	toolResults?: Map<string, ToolResultPart>
	consumedToolCallIds?: Set<string>
}) {
	switch (part.type) {
		case 'text':
			return isStreaming ? (
				<StreamingMessageResponse isStreaming>
					{part.text}
				</StreamingMessageResponse>
			) : (
				<MessageResponse>{part.text}</MessageResponse>
			)
		case 'tool-call': {
			const matched = part.toolCallId
				? toolResults?.get(part.toolCallId)
				: undefined
			return (
				<ToolCard
					className="my-2"
					name={part.name}
					args={part.args}
					result={matched?.result}
				/>
			)
		}
		case 'tool-result': {
			if (
				part.toolCallId &&
				consumedToolCallIds?.has(part.toolCallId)
			) {
				return null
			}
			return (
				<ToolCard
					className="my-2"
					name={part.toolName ?? 'Result'}
					args={{}}
					result={part.result}
				/>
			)
		}
		case 'memory': {
			const recalledMemories = part.memories ?? []
			if (recalledMemories.length === 0) {
				return (
					<div className="flex items-center gap-2">
						<BookOpenIcon className="size-4 text-muted-foreground" />
						<span className="font-mono text-[11px] tracking-wide text-muted-foreground">
							recalled {part.count}{' '}
							{part.count === 1 ? 'memory' : 'memories'}
							{part.duration_ms != null
								? ` (${(part.duration_ms / 1000).toFixed(1)}s)`
								: ''}
						</span>
					</div>
				)
			}
			return (
				<Reasoning defaultOpen={false} className="mb-0">
					<ReasoningTrigger
						className="text-xs"
						icon={<BookOpenIcon className="size-4" />}
						getThinkingMessage={() => (
							<span className="font-mono text-[11px] tracking-wide">
								recalled {part.count}{' '}
								{part.count === 1 ? 'memory' : 'memories'}
								{part.duration_ms != null
									? ` (${(part.duration_ms / 1000).toFixed(1)}s)`
									: ''}
							</span>
						)}
					/>
					<ReasoningContent className="mt-2 text-xs leading-relaxed">
						{recalledMemories
							.map((m, i) => `${i + 1}. ${m.text}`)
							.join('\n')}
					</ReasoningContent>
				</Reasoning>
			)
		}
		case 'thinking':
			return (
				<Reasoning defaultOpen={false} className="mb-0">
					<ReasoningTrigger className="text-xs" />
					<ReasoningContent className="mt-2 text-xs leading-relaxed">
						{part.text}
					</ReasoningContent>
				</Reasoning>
			)
		case 'memory-retain': {
			const facts = part.facts ?? []
			const modelTag = part.model ? `[${part.model}] ` : ''
			const timingTag = part.duration_ms
				? ` (${(part.duration_ms / 1000).toFixed(1)}s)`
				: ''
			const label = `${modelTag}stored ${part.factsStored} ${part.factsStored === 1 ? 'fact' : 'facts'}${timingTag}`
			if (facts.length === 0) {
				return (
					<div className="flex items-center gap-2">
						<BookOpenIcon className="size-4 text-muted-foreground" />
						<span className="font-mono text-[11px] tracking-wide text-muted-foreground">
							{label}
						</span>
					</div>
				)
			}
			return (
				<Reasoning defaultOpen={false} className="mb-0">
					<ReasoningTrigger
						className="text-xs"
						icon={<BookOpenIcon className="size-4" />}
						getThinkingMessage={() => (
							<span className="font-mono text-[11px] tracking-wide">
								{label}
							</span>
						)}
					/>
					<ReasoningContent className="mt-2 text-xs leading-relaxed">
						{facts
							.map((f, i) => `${i + 1}. ${f}`)
							.join('\n')}
					</ReasoningContent>
				</Reasoning>
			)
		}
		case 'artifact':
			// TODO: artifact renderer
			return (
				<div className="rounded-lg border border-border/50 p-3 text-sm">
					<span className="font-medium">
						{part.title ?? part.filename}
					</span>
					<pre className="mt-2 text-xs overflow-auto max-h-64">
						{part.content}
					</pre>
				</div>
			)
		default:
			return null
	}
})

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false)
	const timerRef = useRef<ReturnType<
		typeof setTimeout
	> | null>(null)

	useEffect(
		() => () => {
			if (timerRef.current) clearTimeout(timerRef.current)
		},
		[]
	)

	const handleCopy = async () => {
		await navigator.clipboard.writeText(text)
		setCopied(true)
		if (timerRef.current) clearTimeout(timerRef.current)
		timerRef.current = setTimeout(
			() => setCopied(false),
			2000
		)
	}

	return (
		<MessageAction
			tooltip={copied ? 'Copied!' : 'Copy'}
			onClick={handleCopy}
		>
			{copied ? (
				<CheckIcon className="size-3.5" />
			) : (
				<CopyIcon className="size-3.5" />
			)}
		</MessageAction>
	)
}

function formatTime(date: Date): string {
	return date.toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit'
	})
}

export const ChatMessageRow = memo(function ChatMessageRow({
	message,
	toolResults,
	consumedToolCallIds
}: {
	message: ChatMessageType
	toolResults?: Map<string, ToolResultPart>
	consumedToolCallIds?: Set<string>
}) {
	// Memory messages render as standalone system-style entries
	if (message.sender === 'memory') {
		return (
			<div className="animate-message-in">
				<div className="flex flex-col gap-2">
					{message.parts.map((part, i) => (
						<PartRenderer
							key={`${part.type}-${i}`}
							part={part}
							toolResults={toolResults}
							consumedToolCallIds={consumedToolCallIds}
						/>
					))}
				</div>
			</div>
		)
	}

	const isUser =
		message.sender === 'human' || message.sender === 'user'

	return (
		<Message
			from={isUser ? 'user' : 'assistant'}
			className="animate-message-in"
		>
			<div className="flex items-baseline gap-1.5 text-[10.5px] text-muted-foreground mb-1 group-[.is-user]:justify-end">
				{message.sender && (
					<span className="font-medium text-foreground/60">
						{message.sender}
					</span>
				)}
				<span className="text-muted-foreground/50">
					{formatTime(message.timestamp)}
				</span>
			</div>
			<MessageContent>
				<div className="flex flex-col gap-2">
					{message.thinking && (
						<Reasoning
							isStreaming={message.isStreaming}
							defaultOpen={false}
							className="mb-0"
						>
							<ReasoningTrigger className="text-xs" />
							<ReasoningContent className="mt-2 text-xs leading-relaxed">
								{message.thinking}
							</ReasoningContent>
						</Reasoning>
					)}
					{message.parts.map((part, i) => (
						<PartRenderer
							key={`${part.type}-${i}`}
							part={part}
							isStreaming={message.isStreaming}
							toolResults={toolResults}
							consumedToolCallIds={consumedToolCallIds}
						/>
					))}
					{message.isStreaming && (
						<span className="inline-block w-1.5 h-4 bg-foreground/50 rounded-sm animate-pulse" />
					)}
				</div>
			</MessageContent>
			{message.text && !message.isStreaming && (
				<MessageActions className="opacity-0 group-hover:opacity-100 transition-opacity group-[.is-user]:ml-auto">
					<CopyButton text={message.text} />
				</MessageActions>
			)}
		</Message>
	)
})
