import { env } from '@ellie/env/client'

const baseUrl = env.API_BASE_URL.replace(/\/$/, '')

export interface SynthesizeSpeechResult {
	uploadId: string
	provider: 'elevenlabs'
	outputFormat: string
	mime: string
	size: number
	voiceCompatible: boolean
	audio: {
		type: 'audio'
		file: string
		mime: string
		size: number
	}
}

export async function synthesizeSpeech(
	text: string
): Promise<SynthesizeSpeechResult> {
	const res = await fetch(`${baseUrl}/api/tts/convert`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ text })
	})

	if (!res.ok) {
		const errBody = await res.text()
		throw new Error(
			`TTS returned ${res.status}: ${errBody}`
		)
	}

	return (await res.json()) as SynthesizeSpeechResult
}
