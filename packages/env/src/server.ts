import { resolve } from 'node:path'
import * as v from 'valibot'

// ============================================================================
// Schema
// ============================================================================

const ServerEnvSchema = v.object({
	/** Base URL for the API server (must include protocol). Used to derive the port. */
	API_BASE_URL: v.optional(
		v.pipe(v.string(), v.url()),
		'http://localhost:3000'
	),

	/** Directory for persistent data storage (resolved to absolute path). */
	DATA_DIR: v.pipe(
		v.optional(v.string(), './data'),
		v.transform(p => resolve(p))
	),

	/** Anthropic API key (optional — only needed if using Anthropic provider). */
	ANTHROPIC_API_KEY: v.optional(v.string()),

	/** Anthropic model ID for the agent adapter (default: claude-sonnet-4-5). */
	ANTHROPIC_MODEL: v.optional(
		v.pipe(v.string(), v.nonEmpty()),
		'claude-sonnet-4-5'
	),

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
	HINDSIGHT_TEI_RERANK_MAX_CONCURRENT: v.optional(
		v.string()
	),

	/** Python parity fallback for embedding TEI URL. */
	HINDSIGHT_API_EMBEDDINGS_TEI_URL: v.optional(v.string()),
	/** Python parity fallback for reranker TEI URL. */
	HINDSIGHT_API_RERANKER_TEI_URL: v.optional(v.string()),

	// ── Agent guardrail limits (disabled when unset, empty, 0, or negative) ──

	/** Maximum wall-clock time per agent run in milliseconds. */
	AGENT_LIMIT_MAX_WALL_CLOCK_MS: v.optional(v.string()),
	/** Maximum model invocation attempts (including retries) per agent run. */
	AGENT_LIMIT_MAX_MODEL_CALLS: v.optional(v.string()),
	/** Maximum accumulated USD cost per agent run. */
	AGENT_LIMIT_MAX_COST_USD: v.optional(v.string()),

	// ── Exec-mode: script_exec limits ──

	/** Maximum wall-clock time per script_exec invocation in milliseconds (default: 30000). */
	AGENT_SCRIPT_EXEC_TIMEOUT_MS: v.optional(v.string()),
	/** Maximum tool calls per script_exec invocation (default: 64). */
	AGENT_SCRIPT_EXEC_MAX_TOOL_CALLS: v.optional(v.string()),
	/** Maximum output size per script_exec invocation in bytes (default: 262144). */
	AGENT_SCRIPT_EXEC_MAX_OUTPUT_BYTES: v.optional(
		v.string()
	),

	// ── Exec-mode: session_exec limits ──

	/** Maximum wall-clock time per session_exec evaluation in milliseconds (default: 30000). */
	AGENT_SESSION_EXEC_TIMEOUT_MS: v.optional(v.string()),
	/** Maximum raw output size per session_exec evaluation in bytes (default: 262144). */
	AGENT_SESSION_EXEC_MAX_OUTPUT_BYTES: v.optional(
		v.string()
	)
})

// ============================================================================
// Parse & export
// ============================================================================

export type ServerEnv = v.InferOutput<
	typeof ServerEnvSchema
>

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
	HINDSIGHT_TEI_RERANK_URL:
		Bun.env.HINDSIGHT_TEI_RERANK_URL,
	HINDSIGHT_TEI_API_KEY: Bun.env.HINDSIGHT_TEI_API_KEY,
	HINDSIGHT_TEI_RERANK_BATCH_SIZE:
		Bun.env.HINDSIGHT_TEI_RERANK_BATCH_SIZE,
	HINDSIGHT_TEI_RERANK_MAX_CONCURRENT:
		Bun.env.HINDSIGHT_TEI_RERANK_MAX_CONCURRENT,
	HINDSIGHT_API_EMBEDDINGS_TEI_URL:
		Bun.env.HINDSIGHT_API_EMBEDDINGS_TEI_URL,
	HINDSIGHT_API_RERANKER_TEI_URL:
		Bun.env.HINDSIGHT_API_RERANKER_TEI_URL,
	AGENT_LIMIT_MAX_WALL_CLOCK_MS:
		Bun.env.AGENT_LIMIT_MAX_WALL_CLOCK_MS,
	AGENT_LIMIT_MAX_MODEL_CALLS:
		Bun.env.AGENT_LIMIT_MAX_MODEL_CALLS,
	AGENT_LIMIT_MAX_COST_USD:
		Bun.env.AGENT_LIMIT_MAX_COST_USD,
	AGENT_SCRIPT_EXEC_TIMEOUT_MS:
		Bun.env.AGENT_SCRIPT_EXEC_TIMEOUT_MS,
	AGENT_SCRIPT_EXEC_MAX_TOOL_CALLS:
		Bun.env.AGENT_SCRIPT_EXEC_MAX_TOOL_CALLS,
	AGENT_SCRIPT_EXEC_MAX_OUTPUT_BYTES:
		Bun.env.AGENT_SCRIPT_EXEC_MAX_OUTPUT_BYTES,
	AGENT_SESSION_EXEC_TIMEOUT_MS:
		Bun.env.AGENT_SESSION_EXEC_TIMEOUT_MS,
	AGENT_SESSION_EXEC_MAX_OUTPUT_BYTES:
		Bun.env.AGENT_SESSION_EXEC_MAX_OUTPUT_BYTES
})
