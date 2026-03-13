import type { ContentPart } from '@ellie/schemas/chat'
import type { StoredChatMessage } from '@/collections/chat-messages'
import { partHasVisibleOutput } from '../components/part-utils'

export function getVisibleParts(
	parts: ContentPart[],
	consumedToolCallIds?: Set<string>
): ContentPart[] {
	return parts
		.filter(part =>
			partHasVisibleOutput(part, consumedToolCallIds)
		)
		.sort((a, b) => {
			// Audio parts render before text transcriptions
			if (a.type === 'audio' && b.type !== 'audio')
				return -1
			if (a.type !== 'audio' && b.type === 'audio') return 1
			return 0
		})
}

export function getVisibleToolParts(
	toolItems: StoredChatMessage[],
	consumedToolCallIds?: Set<string>
): ContentPart[] {
	return toolItems.flatMap(msg =>
		msg.parts.filter(part =>
			partHasVisibleOutput(part, consumedToolCallIds)
		)
	)
}

export function getSortedArtifactParts(
	artifactItems: StoredChatMessage[]
): ContentPart[] {
	return artifactItems
		.flatMap(msg => msg.parts)
		.sort((a, b) => {
			const aIsAudio =
				a.type === 'assistant-artifact' &&
				a.kind === 'audio'
			const bIsAudio =
				b.type === 'assistant-artifact' &&
				b.kind === 'audio'
			if (aIsAudio && !bIsAudio) return -1
			if (!aIsAudio && bIsAudio) return 1
			return 0
		})
}

export function hasVisibleContent(
	message: StoredChatMessage,
	visibleParts: ContentPart[],
	visibleToolParts: ContentPart[],
	sortedArtifactParts: ContentPart[]
): boolean {
	return (
		!!message.thinking ||
		visibleParts.length > 0 ||
		visibleToolParts.length > 0 ||
		sortedArtifactParts.length > 0
	)
}
