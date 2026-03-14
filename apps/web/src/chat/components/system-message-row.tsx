import type { StoredChatMessage } from '@/chat/types'
import type { ToolResultPart } from '../utils'
import { PartRenderer } from './part-renderer'

export function SystemMessageRow({
	message,
	toolResults,
	consumedToolCallIds
}: {
	message: StoredChatMessage
	toolResults?: Map<string, ToolResultPart>
	consumedToolCallIds?: Set<string>
}) {
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
