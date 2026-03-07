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
	console.log(
		'[speech-client] Input blob — type:',
		audioBlob.type,
		'size:',
		audioBlob.size
	)

	let normalized: Blob
	let normalizedBy = 'none'
	try {
		normalized = await normalizeToWav16kMono(audioBlob)
		normalizedBy = 'client-mediabunny'
		console.log(
			'[speech-client] Normalized — type:',
			normalized.type,
			'size:',
			normalized.size
		)
	} catch (err) {
		console.warn(
			'[speech-client] Audio normalization failed, sending raw blob:',
			err instanceof Error ? err.message : String(err)
		)
		normalized = audioBlob
	}

	const url = `${baseUrl}/api/speech/transcriptions`
	console.log('[speech-client] POST', url)

	const form = new FormData()
	form.append('audio', normalized, 'recording.wav')
	form.append('source', 'microphone')
	form.append('normalizedBy', normalizedBy)

	const t0 = performance.now()
	const res = await fetch(url, {
		method: 'POST',
		body: form
	})
	const elapsed = Math.round(performance.now() - t0)

	console.log(
		`[speech-client] Response — status: ${res.status} in ${elapsed}ms`
	)

	if (!res.ok) {
		const errBody = await res.text()
		console.error(
			'[speech-client] Error response body:',
			errBody
		)
		throw new Error(
			`STT returned ${res.status}: ${errBody}`
		)
	}

	const result = (await res.json()) as TranscriptionResponse
	console.log(
		'[speech-client] Result:',
		JSON.stringify(result)
	)
	return result
}
