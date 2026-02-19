import type { ThinkingLevel, ProviderName } from "./types";

/** Default budget tokens for each thinking level (used by Anthropic). */
const ANTHROPIC_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
	minimal: 1024,
	low: 2048,
	medium: 4096,
	high: 8192,
	xhigh: 16384,
};

/**
 * OpenAI reasoning_effort mapping.
 * xhigh maps to high since OpenAI doesn't have a higher level.
 */
const OPENAI_REASONING_EFFORT: Record<ThinkingLevel, string> = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
};

/**
 * Convert a unified ThinkingLevel into provider-specific modelOptions.
 *
 * Returns an object suitable for spreading into the `modelOptions` field
 * of a TanStack AI `chat()` call:
 *
 * ```ts
 * chat({
 *   adapter: anthropicText("claude-sonnet-4-5"),
 *   messages,
 *   modelOptions: {
 *     ...toThinkingModelOptions("anthropic", "high"),
 *   },
 * })
 * ```
 */
export function toThinkingModelOptions(
	provider: ProviderName,
	level: ThinkingLevel
): Record<string, unknown> {
	switch (provider) {
		case "anthropic":
			return {
				thinking: {
					type: "enabled",
					budget_tokens: ANTHROPIC_THINKING_BUDGETS[level],
				},
			};
		case "openai":
			return {
				reasoning: {
					effort: OPENAI_REASONING_EFFORT[level],
				},
			};
		case "openrouter":
			// OpenRouter passes through to underlying provider
			return {
				reasoning: {
					effort: OPENAI_REASONING_EFFORT[level],
				},
			};
		case "ollama":
			// Ollama does not support thinking/reasoning natively
			return {};
		default:
			return {};
	}
}

/** Check if a provider supports thinking/reasoning. */
export function supportsThinking(provider: ProviderName): boolean {
	return (
		provider === "anthropic" ||
		provider === "openai" ||
		provider === "openrouter"
	);
}
