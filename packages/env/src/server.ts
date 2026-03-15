import { resolve, dirname } from 'node:path'
import * as v from 'valibot'

/** Monorepo root — three levels up from packages/env/src/ */
const MONOREPO_ROOT = resolve(
	dirname(new URL(import.meta.url).pathname),
	'../../..'
)

// Schema

const ServerEnvSchema = v.object({
	/** Base URL for the API server (must include protocol). Used to derive the port. */
	API_BASE_URL: v.optional(
		v.pipe(v.string(), v.url()),
		'http://localhost:3000'
	),

	/** Directory for persistent data storage (resolved relative to monorepo root). */
	DATA_DIR: v.pipe(
		v.optional(v.string(), './data'),
		v.transform(p => resolve(MONOREPO_ROOT, p))
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

	/** Maximum wall-clock time per agent run in milliseconds. */
	AGENT_LIMIT_MAX_WALL_CLOCK_MS: v.optional(v.string()),
	/** Maximum model invocation attempts (including retries) per agent run. */
	AGENT_LIMIT_MAX_MODEL_CALLS: v.optional(v.string()),
	/** Maximum accumulated USD cost per agent run. */
	AGENT_LIMIT_MAX_COST_USD: v.optional(v.string()),

	/** Maximum wall-clock time per script_exec invocation in milliseconds (default: 30000). */
	AGENT_SCRIPT_EXEC_TIMEOUT_MS: v.optional(v.string()),
	/** Maximum tool calls per script_exec invocation (default: 64). */
	AGENT_SCRIPT_EXEC_MAX_TOOL_CALLS: v.optional(v.string()),
	/** Maximum output size per script_exec invocation in bytes (default: 262144). */
	AGENT_SCRIPT_EXEC_MAX_OUTPUT_BYTES: v.optional(
		v.string()
	),

	/** Maximum wall-clock time per session_exec evaluation in milliseconds (default: 30000). */
	AGENT_SESSION_EXEC_TIMEOUT_MS: v.optional(v.string()),
	/** Maximum raw output size per session_exec evaluation in bytes (default: 262144). */
	AGENT_SESSION_EXEC_MAX_OUTPUT_BYTES: v.optional(
		v.string()
	),

	/** Base URL of the Rust STT service (default: http://localhost:3456). */
	STT_BASE_URL: v.optional(
		v.pipe(v.string(), v.url()),
		'http://localhost:3456'
	),

	/** ElevenLabs API key. Falls back to XI_API_KEY when unset. */
	ELEVENLABS_API_KEY: v.optional(v.string()),
	/** Optional ElevenLabs API base URL override. */
	ELEVENLABS_BASE_URL: v.optional(v.string()),
	/** Default ElevenLabs voice ID. */
	ELEVENLABS_VOICE_ID: v.optional(v.string()),
	/** Default ElevenLabs model ID. */
	ELEVENLABS_MODEL_ID: v.optional(v.string()),
	/** Optional default ElevenLabs seed. */
	ELEVENLABS_SEED: v.optional(v.string()),
	/** Optional default text normalization mode: auto, on, off. */
	ELEVENLABS_APPLY_TEXT_NORMALIZATION: v.optional(
		v.string()
	),
	/** Optional default language code (2-letter ISO 639-1). */
	ELEVENLABS_LANGUAGE_CODE: v.optional(v.string()),
	/** Optional default ElevenLabs stability. */
	ELEVENLABS_VOICE_STABILITY: v.optional(v.string()),
	/** Optional default ElevenLabs similarity boost. */
	ELEVENLABS_VOICE_SIMILARITY_BOOST: v.optional(v.string()),
	/** Optional default ElevenLabs style. */
	ELEVENLABS_VOICE_STYLE: v.optional(v.string()),
	/** Optional default ElevenLabs speaker boost flag. */
	ELEVENLABS_VOICE_USE_SPEAKER_BOOST: v.optional(
		v.string()
	),
	/** Optional default ElevenLabs speed. */
	ELEVENLABS_VOICE_SPEED: v.optional(v.string()),
	/** Hard cap for text sent to TTS. */
	TTS_MAX_TEXT_LENGTH: v.optional(v.string()),
	/** TTS request timeout in milliseconds. */
	TTS_TIMEOUT_MS: v.optional(v.string())
})

// Parse & export

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
		Bun.env.AGENT_SESSION_EXEC_MAX_OUTPUT_BYTES,
	STT_BASE_URL: Bun.env.STT_BASE_URL,
	ELEVENLABS_API_KEY: Bun.env.ELEVENLABS_API_KEY,
	ELEVENLABS_BASE_URL: Bun.env.ELEVENLABS_BASE_URL,
	ELEVENLABS_VOICE_ID: Bun.env.ELEVENLABS_VOICE_ID,
	ELEVENLABS_MODEL_ID: Bun.env.ELEVENLABS_MODEL_ID,
	ELEVENLABS_SEED: Bun.env.ELEVENLABS_SEED,
	ELEVENLABS_APPLY_TEXT_NORMALIZATION:
		Bun.env.ELEVENLABS_APPLY_TEXT_NORMALIZATION,
	ELEVENLABS_LANGUAGE_CODE:
		Bun.env.ELEVENLABS_LANGUAGE_CODE,
	ELEVENLABS_VOICE_STABILITY:
		Bun.env.ELEVENLABS_VOICE_STABILITY,
	ELEVENLABS_VOICE_SIMILARITY_BOOST:
		Bun.env.ELEVENLABS_VOICE_SIMILARITY_BOOST,
	ELEVENLABS_VOICE_STYLE: Bun.env.ELEVENLABS_VOICE_STYLE,
	ELEVENLABS_VOICE_USE_SPEAKER_BOOST:
		Bun.env.ELEVENLABS_VOICE_USE_SPEAKER_BOOST,
	ELEVENLABS_VOICE_SPEED: Bun.env.ELEVENLABS_VOICE_SPEED,
	TTS_MAX_TEXT_LENGTH: Bun.env.TTS_MAX_TEXT_LENGTH,
	TTS_TIMEOUT_MS: Bun.env.TTS_TIMEOUT_MS
})
