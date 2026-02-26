/**
 * Auth routes for Anthropic credential management.
 *
 * All endpoints are under /api/auth/anthropic and restricted to localhost.
 * The CLI calls these routes — no credential writing happens client-side.
 */

import { Elysia } from 'elysia'
import {
	loadAnthropicCredential,
	setAnthropicCredential,
	clearAnthropicCredential,
	type AnthropicCredential
} from '@ellie/ai/credentials'
import {
	oauthAuthorize,
	oauthExchange,
	oauthCreateApiKey,
	tokensToCredential
} from '@ellie/ai/anthropic-oauth'
import {
	errorSchema,
	authStatusResponseSchema,
	authClearResponseSchema,
	authApiKeyBodySchema,
	authApiKeyResponseSchema,
	authTokenBodySchema,
	authTokenResponseSchema,
	authOAuthAuthorizeBodySchema,
	authOAuthAuthorizeResponseSchema,
	authOAuthExchangeBodySchema,
	authOAuthExchangeResponseSchema
} from './common'

// ── Localhost guard ──────────────────────────────────────────────────────────

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

// ── Route factory ────────────────────────────────────────────────────────────

export function createAuthRoutes(
	credentialsPath: string,
	onCredentialChange?: () => void
) {
	return (
		new Elysia({
			prefix: '/api/auth/anthropic',
			tags: ['Auth']
		})
			.onBeforeHandle(({ request, server, set }) => {
				const ip = server?.requestIP(request)
				const addr = ip?.address
				if (!addr || !LOOPBACK_ADDRS.has(addr)) {
					set.status = 403
					return {
						error:
							'Auth routes are only available from localhost'
					}
				}
			})

			// ── GET /status ────────────────────────────────────────
			.get(
				'/status',
				async () => {
					// Priority: env vars first
					const envOAuth = process.env.ANTHROPIC_OAUTH_TOKEN
					if (envOAuth) {
						return {
							mode: 'oauth' as const,
							source: 'env_oauth' as const,
							configured: true
						}
					}

					const envToken =
						process.env.ANTHROPIC_BEARER_TOKEN
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

					// File fallback
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
					if (
						'expires' in cred &&
						cred.expires !== undefined
					) {
						result.expires_at = cred.expires
						result.expired = Date.now() >= cred.expires
					}

					return result
				},
				{
					response: {
						200: authStatusResponseSchema,
						403: errorSchema
					}
				}
			)

			// ── POST /clear ────────────────────────────────────────
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

			// ── POST /api-key ──────────────────────────────────────
			.post(
				'/api-key',
				async ({ body, set }) => {
					const { key, validate = true } = body

					if (validate) {
						try {
							// Use GET /v1/models — free endpoint that returns 401
							// for invalid keys without consuming billing tokens.
							const res = await fetch(
								'https://api.anthropic.com/v1/models',
								{
									method: 'GET',
									headers: {
										'x-api-key': key.trim(),
										'anthropic-version': '2023-06-01'
									}
								}
							)
							if (res.status === 401) {
								set.status = 401
								return {
									error:
										'Invalid API key (401 from Anthropic)'
								}
							}
							// Any non-401 response is acceptable
						} catch (err) {
							// Network errors shouldn't block saving
							console.warn(
								'[auth] API key validation network error:',
								err instanceof Error ? err.message : err
							)
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
						set.status = 500
						return { error: result.error }
					}

					onCredentialChange?.()
					return {
						ok: true as const,
						mode: 'api_key' as const
					}
				},
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

			// ── POST /token ────────────────────────────────────────
			.post(
				'/token',
				async ({ body, set }) => {
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
						set.status = 500
						return { error: result.error }
					}

					onCredentialChange?.()
					return {
						ok: true as const,
						mode: 'token' as const
					}
				},
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

			// ── POST /oauth/authorize ──────────────────────────────
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

			// ── POST /oauth/exchange ───────────────────────────────
			.post(
				'/oauth/exchange',
				async ({ body, set }) => {
					const { callback_code, verifier, mode } = body

					const exchangeResult = await oauthExchange(
						callback_code,
						verifier
					)
					if (!exchangeResult.ok) {
						set.status = 400
						return {
							error: exchangeResult.error
						}
					}

					if (mode === 'console') {
						// Console flow: create API key from OAuth token
						const keyResult = await oauthCreateApiKey(
							exchangeResult.tokens.accessToken
						)
						if (!keyResult.ok) {
							set.status = 500
							return {
								error: keyResult.error
							}
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
							set.status = 500
							return {
								error: saveResult.error
							}
						}

						onCredentialChange?.()
						return {
							ok: true as const,
							mode: 'api_key' as const,
							message:
								'API key created and saved from console OAuth flow'
						}
					}

					// Max flow: save OAuth credential
					const cred = tokensToCredential(
						exchangeResult.tokens
					)
					const saveResult = await setAnthropicCredential(
						credentialsPath,
						cred
					)
					if (!saveResult.ok) {
						set.status = 500
						return { error: saveResult.error }
					}

					onCredentialChange?.()
					return {
						ok: true as const,
						mode: 'oauth' as const,
						message: 'OAuth tokens saved (Max plan)'
					}
				},
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
	)
}
