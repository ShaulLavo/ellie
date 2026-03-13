import type { ContentPart } from '@ellie/schemas/chat'
import {
	MessageResponse,
	StreamingMessageResponse
} from '@/components/ai-elements/message'

type TextPart = Extract<ContentPart, { type: 'text' }>

export function TextPartRenderer({
	part,
	isStreaming,
	isTranscription
}: {
	part: TextPart
	isStreaming?: boolean
	isTranscription?: boolean
}) {
	if (isTranscription) {
		return (
			<MessageResponse className="prose-sm italic text-muted-foreground [&_*]:text-muted-foreground">
				{part.text}
			</MessageResponse>
		)
	}
	return isStreaming ? (
		<StreamingMessageResponse isStreaming>
			{part.text}
		</StreamingMessageResponse>
	) : (
		<MessageResponse>{part.text}</MessageResponse>
	)
}
