/**
 * Regex patterns matching provider-specific context overflow error messages.
 * Sourced from pi-ai's overflow detection covering Anthropic, OpenAI,
 * OpenRouter, and generic OpenAI-compatible APIs.
 */
const OVERFLOW_PATTERNS: RegExp[] = [
	// Anthropic: "prompt is too long: 123456 tokens > 200000 maximum"
	/prompt is too long/i,
	// OpenAI: "This model's maximum context length is X tokens"
	/maximum context length/i,
	/exceeds the context window/i,
	// OpenRouter: "maximum context length is X tokens"
	/maximum context length is \d+ tokens/i,
	// Generic fallback patterns (llama.cpp, LM Studio, etc.)
	/context length exceeded/i,
	/token limit exceeded/i,
	/reduce the length of the messages/i,
	/input is too long/i,
];

/**
 * Detect whether an error indicates a context overflow.
 *
 * Two mechanisms:
 * 1. Pattern matching against known provider error messages
 * 2. Silent overflow detection by comparing input tokens to contextWindow
 *    (for Ollama and other providers that don't error explicitly)
 */
export function isContextOverflow(
	message: string,
	inputTokens?: number,
	contextWindow?: number
): boolean {
	for (const pattern of OVERFLOW_PATTERNS) {
		if (pattern.test(message)) {
			return true;
		}
	}

	// Silent overflow detection
	if (
		inputTokens !== undefined &&
		contextWindow !== undefined &&
		inputTokens > contextWindow
	) {
		return true;
	}

	return false;
}

/** Returns the overflow detection patterns (for testing/extension). */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
