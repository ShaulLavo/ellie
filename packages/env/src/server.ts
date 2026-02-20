import * as v from "valibot"

// ============================================================================
// Schema
// ============================================================================

const ServerEnvSchema = v.object({
  /** Base URL for the API server (must include protocol). Used to derive the port. */
  API_BASE_URL: v.optional(v.pipe(v.string(), v.url()), "http://localhost:3000"),

  /** Directory for persistent data storage. */
  DATA_DIR: v.optional(v.string(), "./data"),

  /** Anthropic API key (optional — only needed if using Anthropic provider). */
  ANTHROPIC_API_KEY: v.optional(v.string()),

  /** OpenAI API key (optional — only needed if using OpenAI provider). */
  OPENAI_API_KEY: v.optional(v.string()),

  /** OpenRouter API key (optional — only needed if using OpenRouter provider). */
  OPENROUTER_API_KEY: v.optional(v.string()),
})

// ============================================================================
// Parse & export
// ============================================================================

export type ServerEnv = v.InferOutput<typeof ServerEnvSchema>

/**
 * Validated server environment.
 *
 * Parsed eagerly on first import — throws a ValiError at startup if
 * any required variable is missing or malformed.
 *
 * Optional variables (API keys) will be `undefined` when not set.
 */
export const env: ServerEnv = v.parse(ServerEnvSchema, {
  API_BASE_URL: Bun.env.API_BASE_URL,
  DATA_DIR: Bun.env.DATA_DIR,
  ANTHROPIC_API_KEY: Bun.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: Bun.env.OPENAI_API_KEY,
  OPENROUTER_API_KEY: Bun.env.OPENROUTER_API_KEY,
})
