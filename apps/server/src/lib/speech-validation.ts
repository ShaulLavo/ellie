/**
 * Validation and coercion for speech artifact metadata.
 */

const VALID_SOURCES = ['microphone'] as const
const VALID_FLOWS = ['transcript-first'] as const
const VALID_NORMALIZED_BY = [
	'client-mediabunny',
	'server-ffmpeg',
	'none'
] as const

export type SpeechSource = (typeof VALID_SOURCES)[number]
export type SpeechFlow = (typeof VALID_FLOWS)[number]
export type SpeechNormalizedBy =
	(typeof VALID_NORMALIZED_BY)[number]

export interface SpeechMeta {
	ref: string
	source: SpeechSource
	flow: SpeechFlow
	mime: string
	normalizedBy: SpeechNormalizedBy
}

/**
 * Validate and coerce raw speech artifact fields into typed metadata.
 * Unknown values fall back to safe defaults.
 */
export function validateSpeechArtifact(artifact: {
	id: string
	source: string
	flow: string
	mime: string
	normalizedBy: string
}): SpeechMeta {
	const source = (
		VALID_SOURCES as readonly string[]
	).includes(artifact.source)
		? (artifact.source as SpeechSource)
		: 'microphone'

	const flow = (VALID_FLOWS as readonly string[]).includes(
		artifact.flow
	)
		? (artifact.flow as SpeechFlow)
		: 'transcript-first'

	const normalizedBy = (
		VALID_NORMALIZED_BY as readonly string[]
	).includes(artifact.normalizedBy)
		? (artifact.normalizedBy as SpeechNormalizedBy)
		: 'none'

	return {
		ref: artifact.id,
		source,
		flow,
		mime: artifact.mime,
		normalizedBy
	}
}
