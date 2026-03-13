import type { ContentPart } from '@ellie/schemas/chat'
import type { ToolResultPart } from '../utils'
import { PartRenderer } from './part-renderer'

export function MessageToolParts({
	parts,
	toolResults,
	consumedToolCallIds
}: {
	parts: ContentPart[]
	toolResults?: Map<string, ToolResultPart>
	consumedToolCallIds?: Set<string>
}) {
	if (parts.length === 0) return null

	return (
		<>
			{parts.map((part, i) => (
				<PartRenderer
					key={`tool-${i}`}
					part={part}
					toolResults={toolResults}
					consumedToolCallIds={consumedToolCallIds}
				/>
			))}
		</>
	)
}
