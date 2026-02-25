import { env, type ServerEnv } from '@ellie/env/server'
import type { ProviderName } from './types'

const ENV_KEY_MAP: Record<
	ProviderName,
	keyof ServerEnv | null
> = {
	anthropic: 'ANTHROPIC_API_KEY',
	openai: 'OPENAI_API_KEY',
	openrouter: 'OPENROUTER_API_KEY',
	ollama: null
}

/**
 * Resolve the API key for a provider from environment variables.
 * Returns undefined if the provider doesn't need a key (Ollama)
 * or the env var is not set.
 */
export function getEnvApiKey(
	provider: ProviderName
): string | undefined {
	const envKey = ENV_KEY_MAP[provider]
	if (!envKey) return undefined

	return env[envKey] || undefined
}

/** Check if a provider has an API key available in the environment. */
export function hasEnvApiKey(
	provider: ProviderName
): boolean {
	if (provider === 'ollama') return true
	return getEnvApiKey(provider) !== undefined
}
