import type { ContentPart } from '@ellie/schemas/chat'
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
