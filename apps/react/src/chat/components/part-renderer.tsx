import { memo } from 'react'
import { BookOpenIcon } from 'lucide-react'
import type { ContentPart } from '@ellie/schemas/chat'
import {
	MessageResponse,
	StreamingMessageResponse
} from '@/components/ai-elements/message'
import {
	Reasoning,
	ReasoningTrigger,
	ReasoningContent
} from '@/components/ai-elements/reasoning'
import { ToolCard } from '@/components/ai-elements/tool'
import type { ToolResultPart } from '../utils'

export const PartRenderer = memo(
	({
		part,
		isStreaming,
		toolResults,
		consumedToolCallIds
	}: {
		part: ContentPart
		isStreaming?: boolean
		toolResults?: Map<string, ToolResultPart>
		consumedToolCallIds?: Set<string>
	}) => {
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
				const modelTag = part.model
					? `[${part.model}] `
					: ''
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
	}
)
