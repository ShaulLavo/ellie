import * as v from 'valibot'

// ── Auth schemas ─────────────────────────────────────────────────────────────

export const authStatusResponseSchema = v.object({
	mode: v.nullable(
		v.picklist(['api_key', 'token', 'oauth'])
	),
	source: v.picklist([
		'env_api_key',
		'env_token',
		'env_oauth',
		'file',
		'none'
	]),
	configured: v.boolean(),
	expires_at: v.optional(v.number()),
	expired: v.optional(v.boolean()),
	preview: v.optional(v.string())
})

export const authClearResponseSchema = v.object({
	cleared: v.boolean()
})

export const authApiKeyBodySchema = v.object({
	key: v.pipe(v.string(), v.nonEmpty()),
	validate: v.optional(v.boolean())
})

export const authApiKeyResponseSchema = v.object({
	ok: v.literal(true),
	mode: v.literal('api_key')
})

export const authTokenBodySchema = v.object({
	token: v.pipe(v.string(), v.nonEmpty()),
	expires: v.optional(v.number())
})

export const authTokenResponseSchema = v.object({
	ok: v.literal(true),
	mode: v.literal('token')
})

export const authOAuthAuthorizeBodySchema = v.object({
	mode: v.picklist(['max', 'console'])
})

export const authOAuthAuthorizeResponseSchema = v.object({
	url: v.string(),
	verifier: v.string(),
	mode: v.picklist(['max', 'console'])
})

export const authOAuthExchangeBodySchema = v.object({
	callback_code: v.pipe(v.string(), v.nonEmpty()),
	verifier: v.pipe(v.string(), v.nonEmpty()),
	mode: v.picklist(['max', 'console'])
})

export const authOAuthExchangeResponseSchema = v.object({
	ok: v.literal(true),
	mode: v.picklist(['oauth', 'api_key']),
	message: v.string()
})

// ── Groq auth schemas ────────────────────────────────────────────────────────

export const groqAuthStatusResponseSchema = v.object({
	mode: v.nullable(v.literal('api_key')),
	source: v.picklist(['env_api_key', 'file', 'none']),
	configured: v.boolean(),
	preview: v.optional(v.string())
})

export const groqAuthClearResponseSchema = v.object({
	cleared: v.boolean()
})

export const groqAuthApiKeyBodySchema = v.object({
	key: v.pipe(v.string(), v.nonEmpty()),
	validate: v.optional(v.boolean())
})

export const groqAuthApiKeyResponseSchema = v.object({
	ok: v.literal(true),
	mode: v.literal('api_key')
})

// ── Brave auth schemas ──────────────────────────────────────────────────────

export const braveAuthStatusResponseSchema = v.object({
	mode: v.nullable(v.literal('api_key')),
	source: v.picklist(['env_api_key', 'file', 'none']),
	configured: v.boolean(),
	preview: v.optional(v.string())
})

export const braveAuthClearResponseSchema = v.object({
	cleared: v.boolean()
})

export const braveAuthApiKeyBodySchema = v.object({
	key: v.pipe(v.string(), v.nonEmpty()),
	validate: v.optional(v.boolean())
})

export const braveAuthApiKeyResponseSchema = v.object({
	ok: v.literal(true),
	mode: v.literal('api_key')
})

// ── ElevenLabs auth schemas ─────────────────────────────────────────────────

export const elevenlabsAuthStatusResponseSchema = v.object({
	mode: v.nullable(v.literal('api_key')),
	source: v.picklist(['env_api_key', 'file', 'none']),
	configured: v.boolean(),
	preview: v.optional(v.string())
})

export const elevenlabsAuthClearResponseSchema = v.object({
	cleared: v.boolean()
})

export const elevenlabsAuthApiKeyBodySchema = v.object({
	key: v.pipe(v.string(), v.nonEmpty()),
	validate: v.optional(v.boolean())
})

export const elevenlabsAuthApiKeyResponseSchema = v.object({
	ok: v.literal(true),
	mode: v.literal('api_key')
})

// ── CivitAI auth schemas ────────────────────────────────────────────────────

export const civitaiAuthStatusResponseSchema = v.object({
	mode: v.nullable(v.literal('api_key')),
	source: v.picklist(['env_api_key', 'file', 'none']),
	configured: v.boolean(),
	preview: v.optional(v.string())
})

export const civitaiAuthClearResponseSchema = v.object({
	cleared: v.boolean()
})

export const civitaiAuthApiKeyBodySchema = v.object({
	key: v.pipe(v.string(), v.nonEmpty()),
	validate: v.optional(v.boolean())
})

export const civitaiAuthApiKeyResponseSchema = v.object({
	ok: v.literal(true),
	mode: v.literal('api_key')
})
