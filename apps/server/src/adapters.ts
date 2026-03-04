import {
	anthropicOAuth,
	refreshNormalizedOAuthToken
} from '@ellie/ai/anthropic-oauth'
import {
	loadAnthropicCredential,
	loadGroqCredential,
	setAnthropicCredential
} from '@ellie/ai/credentials'
import { groqChat } from '@ellie/ai/openai-compat'
import { env } from '@ellie/env/server'
import type { AnyTextAdapter } from '@tanstack/ai'
import {
	type AnthropicChatModel,
	anthropicText,
	createAnthropicChat
} from '@tanstack/ai-anthropic'

const REFRESH_BUFFER_MS = 5 * 60 * 1000

/** Refresh an OAuth token if expired/expiring, returning the access token to use. */
export async function refreshOAuthIfNeeded(
	credentialsPath: string,
	cred: {
		access: string
		refresh: string
		expires: number
	}
): Promise<string> {
	if (cred.expires - Date.now() >= REFRESH_BUFFER_MS) {
		return cred.access
	}
	const refreshed = await refreshNormalizedOAuthToken(
		cred.refresh
	)
	if (!refreshed) {
		console.warn(
			'[server] OAuth token refresh failed, using existing token'
		)
		return cred.access
	}
	await setAnthropicCredential(credentialsPath, refreshed)
	return refreshed.access
}

export async function resolveAnthropicAdapter(
	credentialsPath: string
): Promise<AnyTextAdapter | null> {
	const model = env.ANTHROPIC_MODEL as AnthropicChatModel

	// ANTHROPIC_OAUTH_TOKEN and ANTHROPIC_BEARER_TOKEN are intentionally read
	// from process.env rather than the validated env schema — they are rarely
	// used override tokens (e.g. for Max plan OAuth) that don't belong in the
	// standard server config schema.
	const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN
	if (oauthToken) return anthropicOAuth(model, oauthToken)

	const bearerToken = process.env.ANTHROPIC_BEARER_TOKEN
	if (bearerToken)
		return createAnthropicChat(model, bearerToken)

	if (env.ANTHROPIC_API_KEY) return anthropicText(model)

	// File fallback
	const cred =
		await loadAnthropicCredential(credentialsPath)
	if (!cred) return null

	switch (cred.type) {
		case 'api_key':
			return createAnthropicChat(model, cred.key)
		case 'oauth': {
			const token = await refreshOAuthIfNeeded(
				credentialsPath,
				cred
			)
			return anthropicOAuth(model, token)
		}
		case 'token':
			return createAnthropicChat(model, cred.token)
		default:
			cred satisfies never
			return null
	}
}

export async function resolveGroqAdapter(
	credentialsPath: string
): Promise<AnyTextAdapter | null> {
	const cred = await loadGroqCredential(credentialsPath)
	if (cred) {
		return groqChat('openai/gpt-oss-120b', cred.key)
	}
	return null
}

/** Agent adapter — Anthropic only. */
export async function resolveAgentAdapter(
	credentialsPath: string
): Promise<AnyTextAdapter | null> {
	return resolveAnthropicAdapter(credentialsPath)
}
