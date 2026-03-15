import { Elysia } from 'elysia'
import {
	loadAnthropicCredential,
	setAnthropicCredential,
	clearAnthropicCredential,
	type AnthropicCredential,
	loadGroqCredential,
	setGroqCredential,
	clearGroqCredential,
	loadBraveCredential,
	setBraveCredential,
	clearBraveCredential,
	loadElevenLabsCredential,
	setElevenLabsCredential,
	clearElevenLabsCredential,
	loadCivitaiCredential,
	setCivitaiCredential,
	clearCivitaiCredential
} from '@ellie/ai/credentials'
import {
	oauthAuthorize,
	oauthExchange,
	oauthCreateApiKey,
	tokensToCredential
} from '@ellie/ai/anthropic-oauth'
import { errorSchema } from './schemas/common-schemas'
import {
	authStatusResponseSchema,
	authClearResponseSchema,
	authApiKeyBodySchema,
	authApiKeyResponseSchema,
	authTokenBodySchema,
	authTokenResponseSchema,
	authOAuthAuthorizeBodySchema,
	authOAuthAuthorizeResponseSchema,
	authOAuthExchangeBodySchema,
	authOAuthExchangeResponseSchema,
	providerAuthStatusResponseSchema,
	providerAuthClearResponseSchema,
	providerAuthApiKeyBodySchema,
	providerAuthApiKeyResponseSchema
} from './schemas/auth-schemas'
import {
	BadRequestError,
	InternalServerError,
	UnauthorizedError
} from './http-errors'
import { requireLoopback } from './loopback-guard'

function keyPreview(key: string): string {
	if (key.length <= 16) return `${key.slice(0, 4)}...`
	return `${key.slice(0, 12)}...${key.slice(-4)}`
}

// ---------------------------------------------------------------------------
// Generic provider auth routes factory (api_key-only providers)
// ---------------------------------------------------------------------------

interface ProviderConfig {
	/** Route prefix, e.g. "groq" -> /api/auth/groq */
	name: string
	/** Environment variable names to check for the key */
	envVars: string[]
	/** Load credential from file */
	load: (
		path: string
	) => Promise<{ type: 'api_key'; key: string } | null>
	/** Save credential to file */
	set: (
		path: string,
		cred: { type: 'api_key'; key: string }
	) => Promise<{ ok: true } | { ok: false; error: string }>
	/** Clear credential from file */
	clear: (path: string) => Promise<boolean>
	/** Validate the API key against the provider, returns error string or null */
	validate: (key: string) => Promise<string | null>
}

function createProviderAuthRoutes(
	config: ProviderConfig,
	credentialsPath: string,
	onCredentialChange?: () => void
) {
	return new Elysia({
		prefix: `/api/auth/${config.name}`,
		tags: ['Auth']
	})
		.onBeforeHandle(requireLoopback)

		.get(
			'/status',
			async () => {
				for (const envName of config.envVars) {
					const envKey = process.env[envName]
					if (envKey) {
						return {
							mode: 'api_key' as const,
							source: 'env_api_key' as const,
							configured: true,
							preview: keyPreview(envKey)
						}
					}
				}

				const cred = await config.load(credentialsPath)
				if (!cred) {
					return {
						mode: null,
						source: 'none' as const,
						configured: false
					}
				}

				return {
					mode: 'api_key' as const,
					source: 'file' as const,
					configured: true,
					preview: keyPreview(cred.key)
				}
			},
			{
				response: {
					200: providerAuthStatusResponseSchema,
					403: errorSchema
				}
			}
		)

		.post(
			'/clear',
			async () => {
				const cleared = await config.clear(credentialsPath)
				if (cleared) onCredentialChange?.()
				return { cleared }
			},
			{
				response: {
					200: providerAuthClearResponseSchema,
					403: errorSchema
				}
			}
		)

		.post(
			'/api-key',
			async ({ body }) => {
				const { key, validate = true } = body

				if (validate) {
					const invalid = await config.validate(key.trim())
					if (invalid) {
						throw new UnauthorizedError(invalid)
					}
				}

				const cred = {
					type: 'api_key' as const,
					key: key.trim()
				}
				const result = await config.set(
					credentialsPath,
					cred
				)
				if (!result.ok) {
					throw new InternalServerError(result.error)
				}

				onCredentialChange?.()
				return {
					ok: true as const,
					mode: 'api_key' as const
				}
			},
			{
				body: providerAuthApiKeyBodySchema,
				response: {
					200: providerAuthApiKeyResponseSchema,
					400: errorSchema,
					401: errorSchema,
					403: errorSchema,
					500: errorSchema
				}
			}
		)
}

// ---------------------------------------------------------------------------
// Validation helpers per provider
// ---------------------------------------------------------------------------

async function validateWithFetch(
	url: string,
	headers: Record<string, string>,
	providerLabel: string,
	failStatuses: number[] = [401]
): Promise<string | null> {
	try {
		const res = await fetch(url, {
			method: 'GET',
			headers
		})
		if (failStatuses.includes(res.status)) {
			return `Invalid API key (${res.status} from ${providerLabel})`
		}
		return null
	} catch (err) {
		console.warn(
			`[auth] ${providerLabel} API key validation network error:`,
			err instanceof Error ? err.message : err
		)
		return null
	}
}

// ---------------------------------------------------------------------------
// Provider configs
// ---------------------------------------------------------------------------

const groqConfig: ProviderConfig = {
	name: 'groq',
	envVars: ['GROQ_API_KEY'],
	load: loadGroqCredential,
	set: setGroqCredential,
	clear: clearGroqCredential,
	validate: key =>
		validateWithFetch(
			'https://api.groq.com/openai/v1/models',
			{ Authorization: `Bearer ${key}` },
			'Groq'
		)
}

const braveConfig: ProviderConfig = {
	name: 'brave',
	envVars: ['BRAVE_API_KEY'],
	load: loadBraveCredential,
	set: setBraveCredential,
	clear: clearBraveCredential,
	validate: key =>
		validateWithFetch(
			'https://api.search.brave.com/res/v1/web/search?q=test&count=1',
			{
				Accept: 'application/json',
				'X-Subscription-Token': key
			},
			'Brave',
			[401, 403]
		)
}

const elevenlabsConfig: ProviderConfig = {
	name: 'elevenlabs',
	envVars: ['ELEVENLABS_API_KEY', 'XI_API_KEY'],
	load: loadElevenLabsCredential,
	set: setElevenLabsCredential,
	clear: clearElevenLabsCredential,
	validate: key =>
		validateWithFetch(
			'https://api.elevenlabs.io/v1/voices',
			{ 'xi-api-key': key },
			'ElevenLabs'
		)
}

const civitaiConfig: ProviderConfig = {
	name: 'civitai',
	envVars: ['CIVITAI_TOKEN'],
	load: loadCivitaiCredential,
	set: setCivitaiCredential,
	clear: clearCivitaiCredential,
	validate: key =>
		validateWithFetch(
			'https://civitai.com/api/v1/models?limit=1',
			{ Authorization: `Bearer ${key}` },
			'CivitAI'
		)
}

// ---------------------------------------------------------------------------
// Exported route constructors
// ---------------------------------------------------------------------------

export function createGroqAuthRoutes(
	credentialsPath: string,
	onCredentialChange?: () => void
) {
	return createProviderAuthRoutes(
		groqConfig,
		credentialsPath,
		onCredentialChange
	)
}

export function createBraveAuthRoutes(
	credentialsPath: string,
	onCredentialChange?: () => void
) {
	return createProviderAuthRoutes(
		braveConfig,
		credentialsPath,
		onCredentialChange
	)
}

export function createElevenLabsAuthRoutes(
	credentialsPath: string,
	onCredentialChange?: () => void
) {
	return createProviderAuthRoutes(
		elevenlabsConfig,
		credentialsPath,
		onCredentialChange
	)
}

export function createCivitaiAuthRoutes(
	credentialsPath: string,
	onCredentialChange?: () => void
) {
	return createProviderAuthRoutes(
		civitaiConfig,
		credentialsPath,
		onCredentialChange
	)
}

// ---------------------------------------------------------------------------
// Anthropic auth routes (special: supports oauth, token, and api_key)
// ---------------------------------------------------------------------------

async function validateAnthropicApiKey(
	key: string
): Promise<string | null> {
	return validateWithFetch(
		'https://api.anthropic.com/v1/models',
		{
			'x-api-key': key,
			'anthropic-version': '2023-06-01'
		},
		'Anthropic'
	)
}

async function handleAnthropicStatus(
	credentialsPath: string
) {
	const envOAuth = process.env.ANTHROPIC_OAUTH_TOKEN
	if (envOAuth) {
		return {
			mode: 'oauth' as const,
			source: 'env_oauth' as const,
			configured: true
		}
	}

	const envToken = process.env.ANTHROPIC_BEARER_TOKEN
	if (envToken) {
		return {
			mode: 'token' as const,
			source: 'env_token' as const,
			configured: true
		}
	}

	const envKey = process.env.ANTHROPIC_API_KEY
	if (envKey) {
		return {
			mode: 'api_key' as const,
			source: 'env_api_key' as const,
			configured: true,
			preview: keyPreview(envKey)
		}
	}

	const cred =
		await loadAnthropicCredential(credentialsPath)
	if (!cred) {
		return {
			mode: null,
			source: 'none' as const,
			configured: false
		}
	}

	const result: {
		mode: 'api_key' | 'token' | 'oauth'
		source: 'file'
		configured: true
		preview?: string
		expires_at?: number
		expired?: boolean
	} = {
		mode: cred.type,
		source: 'file' as const,
		configured: true
	}

	if (cred.type === 'api_key') {
		result.preview = keyPreview(cred.key)
	}
	if ('expires' in cred && cred.expires !== undefined) {
		result.expires_at = cred.expires
		result.expired = Date.now() >= cred.expires
	}

	return result
}

async function handleOAuthExchange(
	credentialsPath: string,
	body: {
		callback_code: string
		verifier: string
		mode: string
	},
	onCredentialChange?: () => void
) {
	const { callback_code, verifier, mode } = body

	const exchangeResult = await oauthExchange(
		callback_code,
		verifier
	)
	if (!exchangeResult.ok) {
		throw new BadRequestError(exchangeResult.error)
	}

	if (mode === 'console') {
		const keyResult = await oauthCreateApiKey(
			exchangeResult.tokens.accessToken
		)
		if (!keyResult.ok) {
			throw new InternalServerError(keyResult.error)
		}

		const cred: AnthropicCredential = {
			type: 'api_key',
			key: keyResult.key
		}
		const saveResult = await setAnthropicCredential(
			credentialsPath,
			cred
		)
		if (!saveResult.ok) {
			throw new InternalServerError(saveResult.error)
		}

		onCredentialChange?.()
		return {
			ok: true as const,
			mode: 'api_key' as const,
			message:
				'API key created and saved from console OAuth flow'
		}
	}

	const cred = tokensToCredential(exchangeResult.tokens)
	const saveResult = await setAnthropicCredential(
		credentialsPath,
		cred
	)
	if (!saveResult.ok) {
		throw new InternalServerError(saveResult.error)
	}

	onCredentialChange?.()
	return {
		ok: true as const,
		mode: 'oauth' as const,
		message: 'OAuth tokens saved (Max plan)'
	}
}

async function handleSetApiKey(
	credentialsPath: string,
	body: { key: string; validate?: boolean },
	onCredentialChange?: () => void
) {
	const { key, validate = true } = body

	if (validate) {
		const invalid = await validateAnthropicApiKey(
			key.trim()
		)
		if (invalid) {
			throw new UnauthorizedError(invalid)
		}
	}

	const cred: AnthropicCredential = {
		type: 'api_key',
		key: key.trim()
	}
	const result = await setAnthropicCredential(
		credentialsPath,
		cred
	)
	if (!result.ok) {
		throw new InternalServerError(result.error)
	}

	onCredentialChange?.()
	return {
		ok: true as const,
		mode: 'api_key' as const
	}
}

async function handleSetToken(
	credentialsPath: string,
	body: { token: string; expires?: number },
	onCredentialChange?: () => void
) {
	const { token, expires } = body

	const cred: AnthropicCredential = {
		type: 'token',
		token: token.trim(),
		expires
	}
	const result = await setAnthropicCredential(
		credentialsPath,
		cred
	)
	if (!result.ok) {
		throw new InternalServerError(result.error)
	}

	onCredentialChange?.()
	return {
		ok: true as const,
		mode: 'token' as const
	}
}

export function createAuthRoutes(
	credentialsPath: string,
	onCredentialChange?: () => void
) {
	return new Elysia({
		prefix: '/api/auth/anthropic',
		tags: ['Auth']
	})
		.onBeforeHandle(requireLoopback)
		.get(
			'/status',
			() => handleAnthropicStatus(credentialsPath),
			{
				response: {
					200: authStatusResponseSchema,
					403: errorSchema
				}
			}
		)
		.post(
			'/clear',
			async () => {
				const cleared =
					await clearAnthropicCredential(credentialsPath)
				if (cleared) onCredentialChange?.()
				return { cleared }
			},
			{
				response: {
					200: authClearResponseSchema,
					403: errorSchema
				}
			}
		)
		.post(
			'/api-key',
			({ body }) =>
				handleSetApiKey(
					credentialsPath,
					body,
					onCredentialChange
				),
			{
				body: authApiKeyBodySchema,
				response: {
					200: authApiKeyResponseSchema,
					400: errorSchema,
					401: errorSchema,
					403: errorSchema,
					500: errorSchema
				}
			}
		)
		.post(
			'/token',
			({ body }) =>
				handleSetToken(
					credentialsPath,
					body,
					onCredentialChange
				),
			{
				body: authTokenBodySchema,
				response: {
					200: authTokenResponseSchema,
					400: errorSchema,
					403: errorSchema,
					500: errorSchema
				}
			}
		)
		.post(
			'/oauth/authorize',
			async ({ body }) => {
				const { mode } = body
				const result = await oauthAuthorize(mode)
				return {
					url: result.url,
					verifier: result.verifier,
					mode
				}
			},
			{
				body: authOAuthAuthorizeBodySchema,
				response: {
					200: authOAuthAuthorizeResponseSchema,
					403: errorSchema
				}
			}
		)
		.post(
			'/oauth/exchange',
			({ body }) =>
				handleOAuthExchange(
					credentialsPath,
					body,
					onCredentialChange
				),
			{
				body: authOAuthExchangeBodySchema,
				response: {
					200: authOAuthExchangeResponseSchema,
					400: errorSchema,
					403: errorSchema,
					500: errorSchema
				}
			}
		)
}
