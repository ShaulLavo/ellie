/**
 * Auth routes for Anthropic credential management.
 *
 * All endpoints are under /api/auth and restricted to localhost.
 * The CLI calls these routes — no credential writing happens client-side.
 *
 * Security: The entire application runs exclusively on localhost, so most
 * routes need no auth guard. Auth routes use a localhost guard as
 * defense-in-depth for credential handling specifically — API keys and
 * tokens pass through these endpoints, so the guard prevents accidental
 * exposure if the server were ever bound to a non-loopback interface.
 */

import { Elysia } from 'elysia'
import {
	loadAnthropicCredential,
	setAnthropicCredential,
	clearAnthropicCredential,
	type AnthropicCredential,
	loadGroqCredential,
	setGroqCredential,
	clearGroqCredential,
	type GroqCredential,
	loadBraveCredential,
	setBraveCredential,
	clearBraveCredential,
	type BraveCredential
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
	groqAuthStatusResponseSchema,
	groqAuthClearResponseSchema,
	groqAuthApiKeyBodySchema,
	groqAuthApiKeyResponseSchema,
	braveAuthStatusResponseSchema,
	braveAuthClearResponseSchema,
	braveAuthApiKeyBodySchema,
	braveAuthApiKeyResponseSchema
} from './schemas/auth-schemas'
import {
	BadRequestError,
	ForbiddenError,
	InternalServerError,
	UnauthorizedError
} from './http-errors'

// ── Localhost guard (defense-in-depth for credential endpoints) ──────────────

/** Real client IP addresses considered loopback (IPv4, IPv6, IPv4-mapped IPv6). */
const LOOPBACK_ADDRS = new Set([
	'127.0.0.1',
	'::1',
	'::ffff:127.0.0.1'
])

// ── Helpers ──────────────────────────────────────────────────────────────────

function keyPreview(key: string): string {
	if (key.length <= 16) return `${key.slice(0, 4)}...`
	return `${key.slice(0, 12)}...${key.slice(-4)}`
}

/**
 * Validate an Anthropic API key via GET /v1/models.
 * Returns an error string if invalid, or null if acceptable.
 */
async function validateAnthropicApiKey(
	key: string
): Promise<string | null> {
	try {
		const res = await fetch(
			'https://api.anthropic.com/v1/models',
			{
				method: 'GET',
				headers: {
					'x-api-key': key,
					'anthropic-version': '2023-06-01'
				}
			}
		)
		if (res.status === 401) {
			return 'Invalid API key (401 from Anthropic)'
		}
		// Any non-401 response is acceptable
		return null
	} catch (err) {
		// Network errors shouldn't block saving
		console.warn(
			'[auth] API key validation network error:',
			err instanceof Error ? err.message : err
		)
		return null
	}
}

// ── Route factory ────────────────────────────────────────────────────────────

// ── Anthropic auth handlers ─────────────────────────────────────────────────

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

// ── Route factory ────────────────────────────────────────────────────────────

export function createAuthRoutes(
	credentialsPath: string,
	onCredentialChange?: () => void
) {
	return new Elysia({
		prefix: '/api/auth/anthropic',
		tags: ['Auth']
	})
		.onBeforeHandle(({ request, server }) => {
			const ip = server?.requestIP(request)
			const addr = ip?.address
			if (!addr || !LOOPBACK_ADDRS.has(addr)) {
				throw new ForbiddenError(
					'Auth routes are only available from localhost'
				)
			}
		})
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

// ── Groq auth routes ────────────────────────────────────────────────────────

/**
 * Validate a Groq API key via GET /openai/v1/models.
 * Returns an error string if invalid, or null if acceptable.
 */
async function validateGroqApiKey(
	key: string
): Promise<string | null> {
	try {
		const res = await fetch(
			'https://api.groq.com/openai/v1/models',
			{
				method: 'GET',
				headers: {
					Authorization: `Bearer ${key}`
				}
			}
		)
		if (res.status === 401) {
			return 'Invalid API key (401 from Groq)'
		}
		return null
	} catch (err) {
		console.warn(
			'[auth] Groq API key validation network error:',
			err instanceof Error ? err.message : err
		)
		return null
	}
}

export function createGroqAuthRoutes(
	credentialsPath: string,
	onCredentialChange?: () => void
) {
	return (
		new Elysia({
			prefix: '/api/auth/groq',
			tags: ['Auth']
		})
			.onBeforeHandle(({ request, server }) => {
				const ip = server?.requestIP(request)
				const addr = ip?.address
				if (!addr || !LOOPBACK_ADDRS.has(addr)) {
					throw new ForbiddenError(
						'Auth routes are only available from localhost'
					)
				}
			})

			// ── GET /status ────────────────────────────────────────
			.get(
				'/status',
				async () => {
					const envKey = process.env.GROQ_API_KEY
					if (envKey) {
						return {
							mode: 'api_key' as const,
							source: 'env_api_key' as const,
							configured: true,
							preview: keyPreview(envKey)
						}
					}

					const cred =
						await loadGroqCredential(credentialsPath)
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
						200: groqAuthStatusResponseSchema,
						403: errorSchema
					}
				}
			)

			// ── POST /clear ────────────────────────────────────────
			.post(
				'/clear',
				async () => {
					const cleared =
						await clearGroqCredential(credentialsPath)
					if (cleared) onCredentialChange?.()
					return { cleared }
				},
				{
					response: {
						200: groqAuthClearResponseSchema,
						403: errorSchema
					}
				}
			)

			// ── POST /api-key ──────────────────────────────────────
			.post(
				'/api-key',
				async ({ body }) => {
					const { key, validate = true } = body

					if (validate) {
						const invalid = await validateGroqApiKey(
							key.trim()
						)
						if (invalid) {
							throw new UnauthorizedError(invalid)
						}
					}

					const cred: GroqCredential = {
						type: 'api_key',
						key: key.trim()
					}
					const result = await setGroqCredential(
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
					body: groqAuthApiKeyBodySchema,
					response: {
						200: groqAuthApiKeyResponseSchema,
						400: errorSchema,
						401: errorSchema,
						403: errorSchema,
						500: errorSchema
					}
				}
			)
	)
}

// ── Brave auth routes ────────────────────────────────────────────────────────

/**
 * Validate a Brave Search API key via a test search.
 * Returns an error string if invalid, or null if acceptable.
 */
async function validateBraveApiKey(
	key: string
): Promise<string | null> {
	try {
		const res = await fetch(
			'https://api.search.brave.com/res/v1/web/search?q=test&count=1',
			{
				method: 'GET',
				headers: {
					Accept: 'application/json',
					'X-Subscription-Token': key
				}
			}
		)
		if (res.status === 401 || res.status === 403) {
			return `Invalid API key (${res.status} from Brave)`
		}
		return null
	} catch (err) {
		console.warn(
			'[auth] Brave API key validation network error:',
			err instanceof Error ? err.message : err
		)
		return null
	}
}

export function createBraveAuthRoutes(
	credentialsPath: string,
	onCredentialChange?: () => void
) {
	return (
		new Elysia({
			prefix: '/api/auth/brave',
			tags: ['Auth']
		})
			.onBeforeHandle(({ request, server }) => {
				const ip = server?.requestIP(request)
				const addr = ip?.address
				if (!addr || !LOOPBACK_ADDRS.has(addr)) {
					throw new ForbiddenError(
						'Auth routes are only available from localhost'
					)
				}
			})

			// ── GET /status ────────────────────────────────────────
			.get(
				'/status',
				async () => {
					const envKey = process.env.BRAVE_API_KEY
					if (envKey) {
						return {
							mode: 'api_key' as const,
							source: 'env_api_key' as const,
							configured: true,
							preview: keyPreview(envKey)
						}
					}

					const cred =
						await loadBraveCredential(credentialsPath)
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
						200: braveAuthStatusResponseSchema,
						403: errorSchema
					}
				}
			)

			// ── POST /clear ────────────────────────────────────────
			.post(
				'/clear',
				async () => {
					const cleared =
						await clearBraveCredential(credentialsPath)
					if (cleared) onCredentialChange?.()
					return { cleared }
				},
				{
					response: {
						200: braveAuthClearResponseSchema,
						403: errorSchema
					}
				}
			)

			// ── POST /api-key ──────────────────────────────────────
			.post(
				'/api-key',
				async ({ body }) => {
					const { key, validate = true } = body

					if (validate) {
						const invalid = await validateBraveApiKey(
							key.trim()
						)
						if (invalid) {
							throw new UnauthorizedError(invalid)
						}
					}

					const cred: BraveCredential = {
						type: 'api_key',
						key: key.trim()
					}
					const result = await setBraveCredential(
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
					body: braveAuthApiKeyBodySchema,
					response: {
						200: braveAuthApiKeyResponseSchema,
						400: errorSchema,
						401: errorSchema,
						403: errorSchema,
						500: errorSchema
					}
				}
			)
	)
}
