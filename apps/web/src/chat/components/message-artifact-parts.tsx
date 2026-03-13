import type { ContentPart } from '@ellie/schemas/chat'
import { PartRenderer } from './part-renderer'

export function MessageArtifactParts({
	parts,
	kind
}: {
	parts: ContentPart[]
	kind: 'audio' | 'non-audio'
}) {
	const filtered = parts.filter(p => {
		const isAudio =
			p.type === 'assistant-artifact' && p.kind === 'audio'
		return kind === 'audio' ? isAudio : !isAudio
	})

	if (filtered.length === 0) return null

	return (
		<>
			{filtered.map((part, i) => (
				<PartRenderer
					key={`artifact-${kind}-${i}`}
					part={part}
				/>
			))}
		</>
	)
}
