import type { ContentPart } from '@ellie/schemas/chat'
import type { ToolResultPart } from '../utils'
import { TextPartRenderer } from './parts/text-part'
import {
	ToolCallPartRenderer,
	ToolResultPartRenderer
} from './parts/tool-parts'
import {
	MemoryPartRenderer,
	MemoryRetainPartRenderer
} from './parts/memory-parts'
import { ThinkingPartRenderer } from './parts/thinking-part'
import {
	ImagePartRenderer,
	VideoPartRenderer,
	AudioPartRenderer,
	FilePartRenderer,
	AssistantArtifactPartRenderer
} from './parts/media-parts'
import {
	CheckpointPartRenderer,
	ArtifactPartRenderer
} from './parts/checkpoint-part'
import { ImageGenProgress } from './image-gen-progress'

export function PartRenderer({
	part,
	isStreaming,
	isTranscription,
	toolResults,
	consumedToolCallIds
}: {
	part: ContentPart
	isStreaming?: boolean
	isTranscription?: boolean
	toolResults?: Map<string, ToolResultPart>
	consumedToolCallIds?: Set<string>
}) {
	switch (part.type) {
		case 'text':
			return (
				<TextPartRenderer
					part={part}
					isStreaming={isStreaming}
					isTranscription={isTranscription}
				/>
			)
		case 'tool-call':
			return (
				<ToolCallPartRenderer
					part={part}
					toolResults={toolResults}
					consumedToolCallIds={consumedToolCallIds}
				/>
			)
		case 'tool-result':
			return (
				<ToolResultPartRenderer
					part={part}
					consumedToolCallIds={consumedToolCallIds}
				/>
			)
		case 'memory':
			return <MemoryPartRenderer part={part} />
		case 'thinking':
			return <ThinkingPartRenderer part={part} />
		case 'memory-retain':
			return <MemoryRetainPartRenderer part={part} />
		case 'image':
			return <ImagePartRenderer part={part} />
		case 'video':
			return <VideoPartRenderer part={part} />
		case 'audio':
			return <AudioPartRenderer part={part} />
		case 'file':
			return <FilePartRenderer part={part} />
		case 'assistant-artifact':
			return <AssistantArtifactPartRenderer part={part} />
		case 'checkpoint':
			return <CheckpointPartRenderer part={part} />
		case 'artifact':
			return <ArtifactPartRenderer part={part} />
		case 'image-generation':
			return <ImageGenProgress part={part} />
		default:
			return null
	}
}
