import { BookOpenIcon } from 'lucide-react'
import type { ContentPart } from '@ellie/schemas/chat'
import {
	Reasoning,
	ReasoningTrigger,
	ReasoningContent
} from '@/components/ai-elements/reasoning'

type MemoryPart = Extract<ContentPart, { type: 'memory' }>
type MemoryRetainPart = Extract<
	ContentPart,
	{ type: 'memory-retain' }
>

export function MemoryPartRenderer({
	part
}: {
	part: MemoryPart
}) {
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
					.map(
						(m, i) =>
							`${i + 1}. ${m.text.replace(/\|/g, '—')}`
					)
					.join('\n\n')}
			</ReasoningContent>
		</Reasoning>
	)
}

export function MemoryRetainPartRenderer({
	part
}: {
	part: MemoryRetainPart
}) {
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
					.map(
						(f, i) => `${i + 1}. ${f.replace(/\|/g, '—')}`
					)
					.join('\n\n')}
			</ReasoningContent>
		</Reasoning>
	)
}
