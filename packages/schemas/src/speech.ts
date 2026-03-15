/**
 * Speech ingestion schemas — shared types for transcript-first and future audio-prompt flows.
 */

import * as v from 'valibot'

export const speechArtifactStatusSchema = v.picklist([
	'draft',
	'claimed',
	'expired'
])

export type SpeechArtifactStatus = v.InferOutput<
	typeof speechArtifactStatusSchema
>

export const speechMetadataSchema = v.object({
	ref: v.string(),
	source: v.picklist(['microphone']),
	flow: v.picklist(['transcript-first']),
	mime: v.string(),
	normalizedBy: v.picklist([
		'client-mediabunny',
		'server-ffmpeg',
		'none'
	])
})

export type SpeechMetadata = v.InferOutput<
	typeof speechMetadataSchema
>

export const transcriptionResponseSchema = v.object({
	text: v.string(),
	speechRef: v.string(),
	speechDetected: v.boolean(),
	durationMs: v.number()
})

export type TranscriptionResponse = v.InferOutput<
	typeof transcriptionResponseSchema
>
