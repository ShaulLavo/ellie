import { env, type ServerEnv } from '@ellie/env/server'
import { loadElevenLabsCredential } from '@ellie/ai/credentials'

const DEFAULT_ELEVENLABS_BASE_URL =
	'https://api.elevenlabs.io'
const DEFAULT_ELEVENLABS_VOICE_ID = 'pMsXgVXv3BLzUgSXRplE'
const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2'
const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TEXT_LENGTH = 4096

const DEFAULT_ELEVENLABS_VOICE_SETTINGS = {
	stability: 0.5,
	similarityBoost: 0.75,
	style: 0.0,
	useSpeakerBoost: true,
	speed: 1.0
}

export interface ElevenLabsVoiceSettings {
	stability: number
	similarityBoost: number
	style: number
	useSpeakerBoost: boolean
	speed: number
}

export interface ElevenLabsTtsConfig {
	apiKey?: string
	baseUrl: string
	voiceId: string
	modelId: string
	seed?: number
	applyTextNormalization?: 'auto' | 'on' | 'off'
	languageCode?: string
	voiceSettings: ElevenLabsVoiceSettings
	maxTextLength: number
	timeoutMs: number
}

export interface ElevenLabsTtsOverrides {
	voiceId?: string
	modelId?: string
	seed?: number
	applyTextNormalization?: 'auto' | 'on' | 'off'
	languageCode?: string
	voiceSettings?: Partial<ElevenLabsVoiceSettings>
	outputFormat?: string
}

export interface ElevenLabsTtsResult {
	audio: Buffer
	outputFormat: string
	mime: string
	extension: string
	voiceCompatible: boolean
	provider: 'elevenlabs'
}

function parseOptionalNumber(
	value?: string
): number | undefined {
	const trimmed = value?.trim()
	if (!trimmed) return undefined
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid numeric value: ${value}`)
	}
	return parsed
}

function parseOptionalBoolean(
	value?: string
): boolean | undefined {
	const trimmed = value?.trim().toLowerCase()
	if (!trimmed) return undefined
	if (trimmed === 'true') return true
	if (trimmed === 'false') return false
	throw new Error(`Invalid boolean value: ${value}`)
}

export function isValidVoiceId(voiceId: string): boolean {
	return /^[a-zA-Z0-9]{10,40}$/.test(voiceId)
}

export function normalizeElevenLabsBaseUrl(
	baseUrl: string
): string {
	const trimmed = baseUrl.trim()
	if (!trimmed) {
		return DEFAULT_ELEVENLABS_BASE_URL
	}
	return trimmed.replace(/\/+$/, '')
}

function requireInRange(
	value: number,
	min: number,
	max: number,
	label: string
): void {
	if (
		!Number.isFinite(value) ||
		value < min ||
		value > max
	) {
		throw new Error(
			`${label} must be between ${min} and ${max}`
		)
	}
}

export function assertElevenLabsVoiceSettings(
	settings: ElevenLabsVoiceSettings
): void {
	requireInRange(settings.stability, 0, 1, 'stability')
	requireInRange(
		settings.similarityBoost,
		0,
		1,
		'similarityBoost'
	)
	requireInRange(settings.style, 0, 1, 'style')
	requireInRange(settings.speed, 0.5, 2, 'speed')
}

function normalizeLanguageCode(
	code?: string
): string | undefined {
	const trimmed = code?.trim()
	if (!trimmed) {
		return undefined
	}
	const normalized = trimmed.toLowerCase()
	if (!/^[a-z]{2}$/.test(normalized)) {
		throw new Error(
			'languageCode must be a 2-letter ISO 639-1 code (e.g. en, de, fr)'
		)
	}
	return normalized
}

function normalizeApplyTextNormalization(
	mode?: string
): 'auto' | 'on' | 'off' | undefined {
	const trimmed = mode?.trim()
	if (!trimmed) {
		return undefined
	}
	const normalized = trimmed.toLowerCase()
	if (
		normalized === 'auto' ||
		normalized === 'on' ||
		normalized === 'off'
	) {
		return normalized
	}
	throw new Error(
		'applyTextNormalization must be one of: auto, on, off'
	)
}

function normalizeSeed(seed?: number): number | undefined {
	if (seed == null) {
		return undefined
	}
	if (!Number.isInteger(seed)) {
		throw new Error('seed must be an integer')
	}
	if (seed < 0 || seed > 0x7fffffff) {
		throw new Error('seed must be between 0 and 2147483647')
	}
	return seed
}

export function resolveElevenLabsApiKey(
	serverEnv: Pick<ServerEnv, 'ELEVENLABS_API_KEY'> = env
): string | undefined {
	return serverEnv.ELEVENLABS_API_KEY || Bun.env.XI_API_KEY
}

/**
 * Async variant that also checks the credential store file.
 * Priority: env vars → credential file.
 */
export async function resolveElevenLabsApiKeyAsync(
	credentialsPath: string,
	serverEnv: Pick<ServerEnv, 'ELEVENLABS_API_KEY'> = env
): Promise<string | undefined> {
	const envKey = resolveElevenLabsApiKey(serverEnv)
	if (envKey) return envKey

	const cred =
		await loadElevenLabsCredential(credentialsPath)
	return cred?.key
}

export function resolveElevenLabsTtsConfig(
	serverEnv: Pick<
		ServerEnv,
		| 'ELEVENLABS_API_KEY'
		| 'ELEVENLABS_BASE_URL'
		| 'ELEVENLABS_VOICE_ID'
		| 'ELEVENLABS_MODEL_ID'
		| 'ELEVENLABS_SEED'
		| 'ELEVENLABS_APPLY_TEXT_NORMALIZATION'
		| 'ELEVENLABS_LANGUAGE_CODE'
		| 'ELEVENLABS_VOICE_STABILITY'
		| 'ELEVENLABS_VOICE_SIMILARITY_BOOST'
		| 'ELEVENLABS_VOICE_STYLE'
		| 'ELEVENLABS_VOICE_USE_SPEAKER_BOOST'
		| 'ELEVENLABS_VOICE_SPEED'
		| 'TTS_MAX_TEXT_LENGTH'
		| 'TTS_TIMEOUT_MS'
	> = env
): ElevenLabsTtsConfig {
	return {
		apiKey: resolveElevenLabsApiKey(serverEnv),
		baseUrl: normalizeElevenLabsBaseUrl(
			serverEnv.ELEVENLABS_BASE_URL ||
				DEFAULT_ELEVENLABS_BASE_URL
		),
		voiceId:
			serverEnv.ELEVENLABS_VOICE_ID ||
			DEFAULT_ELEVENLABS_VOICE_ID,
		modelId:
			serverEnv.ELEVENLABS_MODEL_ID ||
			DEFAULT_ELEVENLABS_MODEL_ID,
		seed: parseOptionalNumber(serverEnv.ELEVENLABS_SEED),
		applyTextNormalization: normalizeApplyTextNormalization(
			serverEnv.ELEVENLABS_APPLY_TEXT_NORMALIZATION
		),
		languageCode: normalizeLanguageCode(
			serverEnv.ELEVENLABS_LANGUAGE_CODE
		),
		voiceSettings: {
			stability:
				parseOptionalNumber(
					serverEnv.ELEVENLABS_VOICE_STABILITY
				) ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability,
			similarityBoost:
				parseOptionalNumber(
					serverEnv.ELEVENLABS_VOICE_SIMILARITY_BOOST
				) ??
				DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarityBoost,
			style:
				parseOptionalNumber(
					serverEnv.ELEVENLABS_VOICE_STYLE
				) ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.style,
			useSpeakerBoost:
				parseOptionalBoolean(
					serverEnv.ELEVENLABS_VOICE_USE_SPEAKER_BOOST
				) ??
				DEFAULT_ELEVENLABS_VOICE_SETTINGS.useSpeakerBoost,
			speed:
				parseOptionalNumber(
					serverEnv.ELEVENLABS_VOICE_SPEED
				) ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed
		},
		maxTextLength:
			parseOptionalNumber(serverEnv.TTS_MAX_TEXT_LENGTH) ??
			DEFAULT_MAX_TEXT_LENGTH,
		timeoutMs:
			parseOptionalNumber(serverEnv.TTS_TIMEOUT_MS) ??
			DEFAULT_TIMEOUT_MS
	}
}

export function inferExtensionFromOutputFormat(
	outputFormat: string
): string {
	if (outputFormat.startsWith('mp3')) return 'mp3'
	if (outputFormat.startsWith('opus')) return 'opus'
	if (outputFormat.startsWith('pcm')) return 'pcm'
	return 'bin'
}

export function inferMimeTypeFromOutputFormat(
	outputFormat: string
): string {
	if (outputFormat.startsWith('mp3')) return 'audio/mpeg'
	if (outputFormat.startsWith('opus')) return 'audio/ogg'
	if (outputFormat.startsWith('pcm')) return 'audio/wav'
	return 'application/octet-stream'
}

export async function elevenLabsTTS(params: {
	text: string
	config?: ElevenLabsTtsConfig
	overrides?: ElevenLabsTtsOverrides
}): Promise<ElevenLabsTtsResult> {
	const config =
		params.config ?? resolveElevenLabsTtsConfig()
	const overrides = params.overrides ?? {}
	const text = params.text.trim()

	if (!config.apiKey) {
		throw new Error(
			'ElevenLabs API key is not configured (set ELEVENLABS_API_KEY or XI_API_KEY)'
		)
	}
	if (!text) {
		throw new Error('text is required')
	}
	if (text.length > config.maxTextLength) {
		throw new Error(
			`Text too long (${text.length} chars, max ${config.maxTextLength})`
		)
	}

	const voiceId = overrides.voiceId ?? config.voiceId
	const modelId = overrides.modelId ?? config.modelId
	const seed = overrides.seed ?? config.seed
	const applyTextNormalization =
		overrides.applyTextNormalization ??
		config.applyTextNormalization
	const languageCode =
		overrides.languageCode ?? config.languageCode
	const voiceSettings = {
		...config.voiceSettings,
		...overrides.voiceSettings
	}
	const outputFormat =
		overrides.outputFormat ??
		DEFAULT_ELEVENLABS_OUTPUT_FORMAT

	if (!isValidVoiceId(voiceId)) {
		throw new Error('Invalid voiceId format')
	}
	assertElevenLabsVoiceSettings(voiceSettings)

	const normalizedSeed = normalizeSeed(seed)
	const normalizedLanguage =
		normalizeLanguageCode(languageCode)
	const normalizedNormalization =
		normalizeApplyTextNormalization(applyTextNormalization)

	const controller = new AbortController()
	const timeout = setTimeout(
		() => controller.abort(),
		config.timeoutMs
	)

	try {
		const url = new URL(
			`${normalizeElevenLabsBaseUrl(config.baseUrl)}/v1/text-to-speech/${voiceId}`
		)
		if (outputFormat) {
			url.searchParams.set('output_format', outputFormat)
		}

		const response = await fetch(url.toString(), {
			method: 'POST',
			headers: {
				'xi-api-key': config.apiKey,
				'Content-Type': 'application/json',
				Accept: 'audio/mpeg'
			},
			body: JSON.stringify({
				text,
				model_id: modelId,
				seed: normalizedSeed,
				apply_text_normalization: normalizedNormalization,
				language_code: normalizedLanguage,
				voice_settings: {
					stability: voiceSettings.stability,
					similarity_boost: voiceSettings.similarityBoost,
					style: voiceSettings.style,
					use_speaker_boost: voiceSettings.useSpeakerBoost,
					speed: voiceSettings.speed
				}
			}),
			signal: controller.signal
		})

		if (!response.ok) {
			throw new Error(
				`ElevenLabs API error (${response.status})`
			)
		}

		return {
			audio: Buffer.from(await response.arrayBuffer()),
			outputFormat,
			mime: inferMimeTypeFromOutputFormat(outputFormat),
			extension:
				inferExtensionFromOutputFormat(outputFormat),
			voiceCompatible: outputFormat.startsWith('opus'),
			provider: 'elevenlabs'
		}
	} finally {
		clearTimeout(timeout)
	}
}

export const ELEVENLABS_MODELS = [
	'eleven_multilingual_v2',
	'eleven_turbo_v2_5',
	'eleven_monolingual_v1'
] as const
