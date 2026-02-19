import type { ProviderName } from "./types";

const ENV_KEY_MAP: Record<ProviderName, string | null> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	ollama: null,
};

/**
 * Resolve the API key for a provider from environment variables.
 * Returns undefined if the provider doesn't need a key (Ollama)
 * or the env var is not set.
 */
export function getEnvApiKey(provider: ProviderName): string | undefined {
	const envVar = ENV_KEY_MAP[provider];
	if (!envVar) return undefined;

	const env =
		typeof process !== "undefined" ? process.env : (undefined as any);
	if (!env) return undefined;

	return env[envVar] || undefined;
}

/** Check if a provider has an API key available in the environment. */
export function hasEnvApiKey(provider: ProviderName): boolean {
	if (provider === "ollama") return true;
	return getEnvApiKey(provider) !== undefined;
}
