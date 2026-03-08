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
	} catch {
		normalized = audioBlob
	}

	const url = `${baseUrl}/api/speech/transcriptions`

	const form = new FormData()
	form.append('audio', normalized, 'recording.wav')
	form.append('source', 'microphone')
	form.append('normalizedBy', normalizedBy)

	const res = await fetch(url, {
		method: 'POST',
		body: form
	})

	if (!res.ok) {
		const errBody = await res.text()
		throw new Error(
			`STT returned ${res.status}: ${errBody}`
		)
	}

	return (await res.json()) as TranscriptionResponse
}
