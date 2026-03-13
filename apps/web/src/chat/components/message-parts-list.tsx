import type { ContentPart } from '@ellie/schemas/chat'
import type { ToolResultPart } from '../utils'
import { PartRenderer } from './part-renderer'

export function MessagePartsList({
	visibleParts,
	isStreaming,
	hasAudio,
	toolResults,
	consumedToolCallIds
}: {
	visibleParts: ContentPart[]
	isStreaming?: boolean
	hasAudio: boolean
	toolResults?: Map<string, ToolResultPart>
	consumedToolCallIds?: Set<string>
}) {
	return (
		<>
			{visibleParts.map((part, i) => (
				<PartRenderer
					key={`${part.type}-${i}`}
					part={part}
					isStreaming={isStreaming}
					isTranscription={hasAudio && part.type === 'text'}
					toolResults={toolResults}
					consumedToolCallIds={consumedToolCallIds}
				/>
			))}
		</>
	)
}
