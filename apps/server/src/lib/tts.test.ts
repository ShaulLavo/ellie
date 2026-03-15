import { afterEach, describe, expect, it } from 'bun:test'
import {
	assertElevenLabsVoiceSettings,
	elevenLabsTTS,
	isValidVoiceId,
	resolveElevenLabsTtsConfig
} from './tts'

const originalFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = originalFetch
})

describe('tts', () => {
	it('accepts valid ElevenLabs voice IDs', () => {
		expect(isValidVoiceId('pMsXgVXv3BLzUgSXRplE')).toBe(
			true
		)
		expect(isValidVoiceId('voice-with-dashes')).toBe(false)
		expect(isValidVoiceId('short')).toBe(false)
	})

	it('reads ElevenLabs defaults from env-like config', () => {
		const config = resolveElevenLabsTtsConfig({
			ELEVENLABS_API_KEY: 'test-key',
			ELEVENLABS_BASE_URL: 'https://api.elevenlabs.io/',
			ELEVENLABS_VOICE_ID: 'pMsXgVXv3BLzUgSXRplE',
			ELEVENLABS_MODEL_ID: 'eleven_turbo_v2_5',
			ELEVENLABS_SEED: '42',
			ELEVENLABS_APPLY_TEXT_NORMALIZATION: 'on',
			ELEVENLABS_LANGUAGE_CODE: 'EN',
			ELEVENLABS_VOICE_STABILITY: '0.4',
			ELEVENLABS_VOICE_SIMILARITY_BOOST: '0.6',
			ELEVENLABS_VOICE_STYLE: '0.2',
			ELEVENLABS_VOICE_USE_SPEAKER_BOOST: 'false',
			ELEVENLABS_VOICE_SPEED: '1.1',
			TTS_MAX_TEXT_LENGTH: '1234',
			TTS_TIMEOUT_MS: '5678'
		})

		expect(config.apiKey).toBe('test-key')
		expect(config.baseUrl).toBe('https://api.elevenlabs.io')
		expect(config.voiceId).toBe('pMsXgVXv3BLzUgSXRplE')
		expect(config.modelId).toBe('eleven_turbo_v2_5')
		expect(config.seed).toBe(42)
		expect(config.applyTextNormalization).toBe('on')
		expect(config.languageCode).toBe('en')
		expect(config.voiceSettings).toEqual({
			stability: 0.4,
			similarityBoost: 0.6,
			style: 0.2,
			useSpeakerBoost: false,
			speed: 1.1
		})
		expect(config.maxTextLength).toBe(1234)
		expect(config.timeoutMs).toBe(5678)
	})

	it('validates ElevenLabs voice settings', () => {
		expect(() =>
			assertElevenLabsVoiceSettings({
				stability: 2,
				similarityBoost: 0.5,
				style: 0.5,
				useSpeakerBoost: true,
				speed: 1
			})
		).toThrow('stability must be between 0 and 1')
	})

	it('sends expected ElevenLabs request shape', async () => {
		let requestUrl = ''
		let requestInit: RequestInit | undefined

		globalThis.fetch = (async (
			url: string | URL | Request,
			init?: RequestInit
		) => {
			requestUrl = String(url)
			requestInit = init
			return new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: {
					'content-type': 'audio/mpeg'
				}
			})
		}) as typeof fetch

		const result = await elevenLabsTTS({
			text: 'Hello from Ellie',
			config: {
				apiKey: 'test-key',
				baseUrl: 'https://api.elevenlabs.io',
				voiceId: 'pMsXgVXv3BLzUgSXRplE',
				modelId: 'eleven_multilingual_v2',
				seed: 7,
				applyTextNormalization: 'auto',
				languageCode: 'en',
				voiceSettings: {
					stability: 0.5,
					similarityBoost: 0.75,
					style: 0,
					useSpeakerBoost: true,
					speed: 1
				},
				maxTextLength: 4096,
				timeoutMs: 1000
			},
			overrides: {
				outputFormat: 'mp3_44100_128',
				voiceSettings: {
					stability: 0.4,
					speed: 1.1
				}
			}
		})

		expect(requestUrl).toBe(
			'https://api.elevenlabs.io/v1/text-to-speech/pMsXgVXv3BLzUgSXRplE?output_format=mp3_44100_128'
		)
		expect(requestInit?.method).toBe('POST')
		expect(requestInit?.headers).toEqual({
			'xi-api-key': 'test-key',
			'Content-Type': 'application/json',
			Accept: 'audio/mpeg'
		})
		expect(JSON.parse(String(requestInit?.body))).toEqual({
			text: 'Hello from Ellie',
			model_id: 'eleven_multilingual_v2',
			seed: 7,
			apply_text_normalization: 'auto',
			language_code: 'en',
			voice_settings: {
				stability: 0.4,
				similarity_boost: 0.75,
				style: 0,
				use_speaker_boost: true,
				speed: 1.1
			}
		})
		expect(result.provider).toBe('elevenlabs')
		expect(result.outputFormat).toBe('mp3_44100_128')
		expect(result.mime).toBe('audio/mpeg')
		expect(result.extension).toBe('mp3')
		expect(result.voiceCompatible).toBe(false)
		expect(result.audio).toEqual(Buffer.from([1, 2, 3]))
	})
})
