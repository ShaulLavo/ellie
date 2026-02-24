import * as v from 'valibot'

// ============================================================================
// Schema
// ============================================================================

const ServerEnvSchema = v.object({
	/** Base URL for the API server (must include protocol). Used to derive the port. */
	API_BASE_URL: v.optional(v.pipe(v.string(), v.url()), 'http://localhost:3000'),

	/** Directory for persistent data storage. */
	DATA_DIR: v.optional(v.string(), './data'),

	/** Anthropic API key (optional — only needed if using Anthropic provider). */
	ANTHROPIC_API_KEY: v.optional(v.string()),

	/** Anthropic model ID for the agent adapter (default: claude-sonnet-4-5). */
	ANTHROPIC_MODEL: v.optional(v.pipe(v.string(), v.nonEmpty()), 'claude-sonnet-4-5'),

	/** OpenAI API key (optional — only needed if using OpenAI provider). */
	OPENAI_API_KEY: v.optional(v.string()),

	/** OpenRouter API key (optional — only needed if using OpenRouter provider). */
	OPENROUTER_API_KEY: v.optional(v.string()),

	/** Hindsight default TEI embedding endpoint (e.g. http://localhost:8080). */
	HINDSIGHT_TEI_EMBED_URL: v.optional(v.string()),
	/** Hindsight default TEI reranker endpoint (e.g. http://localhost:8081). */
	HINDSIGHT_TEI_RERANK_URL: v.optional(v.string()),
	/** Optional Bearer token for both Hindsight TEI endpoints. */
	HINDSIGHT_TEI_API_KEY: v.optional(v.string()),
	/** Optional rerank batch size override for Hindsight TEI defaults. */
	HINDSIGHT_TEI_RERANK_BATCH_SIZE: v.optional(v.string()),
	/** Optional rerank max-concurrency override for Hindsight TEI defaults. */
	HINDSIGHT_TEI_RERANK_MAX_CONCURRENT: v.optional(v.string()),

	/** Python parity fallback for embedding TEI URL. */
	HINDSIGHT_API_EMBEDDINGS_TEI_URL: v.optional(v.string()),
	/** Python parity fallback for reranker TEI URL. */
	HINDSIGHT_API_RERANKER_TEI_URL: v.optional(v.string())
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
	ANTHROPIC_MODEL: Bun.env.ANTHROPIC_MODEL,
	OPENAI_API_KEY: Bun.env.OPENAI_API_KEY,
	OPENROUTER_API_KEY: Bun.env.OPENROUTER_API_KEY,
	HINDSIGHT_TEI_EMBED_URL: Bun.env.HINDSIGHT_TEI_EMBED_URL,
	HINDSIGHT_TEI_RERANK_URL: Bun.env.HINDSIGHT_TEI_RERANK_URL,
	HINDSIGHT_TEI_API_KEY: Bun.env.HINDSIGHT_TEI_API_KEY,
	HINDSIGHT_TEI_RERANK_BATCH_SIZE: Bun.env.HINDSIGHT_TEI_RERANK_BATCH_SIZE,
	HINDSIGHT_TEI_RERANK_MAX_CONCURRENT: Bun.env.HINDSIGHT_TEI_RERANK_MAX_CONCURRENT,
	HINDSIGHT_API_EMBEDDINGS_TEI_URL: Bun.env.HINDSIGHT_API_EMBEDDINGS_TEI_URL,
	HINDSIGHT_API_RERANKER_TEI_URL: Bun.env.HINDSIGHT_API_RERANKER_TEI_URL
})
