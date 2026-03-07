/**
 * Client-side speech transcription — sends recorded audio to the
 * server's STT proxy and returns the transcript + speechRef.
 */

import type { TranscriptionResponse } from '@ellie/schemas'
import { env } from '@ellie/env/client'
import { normalizeToWav16kMono } from './audio-utils'

const baseUrl = env.API_BASE_URL.replace(/\/$/, '')

export async function transcribeAudio(
	audioBlob: Blob
): Promise<TranscriptionResponse> {
	let normalized: Blob
	let normalizedBy = 'none'
	try {
		normalized = await normalizeToWav16kMono(audioBlob)
		normalizedBy = 'client-mediabunny'
	} catch (err) {
		console.warn(
			'[speech-client] Audio normalization failed, sending raw blob:',
			err instanceof Error ? err.message : String(err)
		)
		normalized = audioBlob
	}

	const form = new FormData()
	form.append('audio', normalized, 'recording.wav')
	form.append('source', 'microphone')
	form.append('normalizedBy', normalizedBy)

	const res = await fetch(
		`${baseUrl}/api/speech/transcriptions`,
		{ method: 'POST', body: form }
	)

	if (!res.ok) {
		const err = await res.json().catch(() => ({
			error: res.statusText
		}))
		throw new Error(
			(err as { error?: string }).error ??
				`STT returned ${res.status}`
		)
	}

	return res.json() as Promise<TranscriptionResponse>
}
