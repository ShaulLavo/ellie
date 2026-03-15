import * as v from 'valibot'

// --- Anthropic-specific schemas (supports oauth/token/api_key) ---

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

// --- Generic provider schemas (api_key only) ---

export const providerAuthStatusResponseSchema = v.object({
	mode: v.nullable(v.literal('api_key')),
	source: v.picklist(['env_api_key', 'file', 'none']),
	configured: v.boolean(),
	preview: v.optional(v.string())
})

export const providerAuthClearResponseSchema = v.object({
	cleared: v.boolean()
})

export const providerAuthApiKeyBodySchema = v.object({
	key: v.pipe(v.string(), v.nonEmpty()),
	validate: v.optional(v.boolean())
})

export const providerAuthApiKeyResponseSchema = v.object({
	ok: v.literal(true),
	mode: v.literal('api_key')
})

// --- Legacy aliases for backward compat with any external imports ---

export const groqAuthStatusResponseSchema =
	providerAuthStatusResponseSchema
export const groqAuthClearResponseSchema =
	providerAuthClearResponseSchema
export const groqAuthApiKeyBodySchema =
	providerAuthApiKeyBodySchema
export const groqAuthApiKeyResponseSchema =
	providerAuthApiKeyResponseSchema

export const braveAuthStatusResponseSchema =
	providerAuthStatusResponseSchema
export const braveAuthClearResponseSchema =
	providerAuthClearResponseSchema
export const braveAuthApiKeyBodySchema =
	providerAuthApiKeyBodySchema
export const braveAuthApiKeyResponseSchema =
	providerAuthApiKeyResponseSchema

export const elevenlabsAuthStatusResponseSchema =
	providerAuthStatusResponseSchema
export const elevenlabsAuthClearResponseSchema =
	providerAuthClearResponseSchema
export const elevenlabsAuthApiKeyBodySchema =
	providerAuthApiKeyBodySchema
export const elevenlabsAuthApiKeyResponseSchema =
	providerAuthApiKeyResponseSchema

export const civitaiAuthStatusResponseSchema =
	providerAuthStatusResponseSchema
export const civitaiAuthClearResponseSchema =
	providerAuthClearResponseSchema
export const civitaiAuthApiKeyBodySchema =
	providerAuthApiKeyBodySchema
export const civitaiAuthApiKeyResponseSchema =
	providerAuthApiKeyResponseSchema
