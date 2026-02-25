/**
 * Ollama wrapper — embedding functions + tracked chat adapter.
 *
 * Wraps @tanstack/ai-ollama (for chat/structured output) and provides
 * embed support via plain fetch() against Ollama's /api/embed endpoint.
 * Adds timeout + retry with exponential backoff for robustness.
 */

import {
	createOllamaChat,
	type OllamaTextAdapter
} from '@tanstack/ai-ollama'

const DEFAULT_BASE_URL = 'http://localhost:11434'

// ── Timeout + retry with exponential backoff ────────────────────────────────

const MAX_RETRIES = 3
const BASE_DELAY_MS = 500 // 500ms → 1000ms → 2000ms
const EMBED_TIMEOUT_MS = 60_000 // 60s — Ollama is local but can be slow on cold start
const STRUCTURED_TIMEOUT_MS = 120_000 // 120s — LLM inference can be slow

/** Race a promise against a timeout. */
async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	message: string
): Promise<T> {
	if (!Number.isFinite(ms) || ms <= 0) return promise
	let timer: ReturnType<typeof setTimeout> | null = null
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms)
	})
	try {
		return await Promise.race([promise, timeout])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function withRetry<T>(
	fn: () => Promise<T>,
	caller: string
): Promise<T> {
	let lastError: Error | null = null
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await withTimeout(
				fn(),
				EMBED_TIMEOUT_MS,
				`Ollama ${caller} timed out after ${EMBED_TIMEOUT_MS / 1000}s`
			)
		} catch (err) {
			lastError =
				err instanceof Error ? err : new Error(String(err))
		}
		if (attempt < MAX_RETRIES) {
			const delay = Math.round(
				BASE_DELAY_MS *
					Math.pow(2, attempt - 1) *
					(1 + Math.random() * 0.2)
			)
			console.warn(
				`[ollama] ${caller} attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms: ${lastError?.message}`
			)
			await Bun.sleep(delay)
		}
	}
	console.error(
		`[ollama] ${caller}: all ${MAX_RETRIES} attempts failed: ${lastError?.message}`
	)
	throw lastError!
}

// ── Chat adapter with timeout ───────────────────────────────────────────────

/**
 * Create an Ollama chat adapter with timeout on structuredOutput.
 *
 * Wraps `createOllamaChat` from `@tanstack/ai-ollama` and adds a
 * timeout guard to `structuredOutput` (120s default).
 *
 * @example
 * ```ts
 * import { ollamaAdapter } from "@ellie/ai/ollama"
 *
 * const adapter = ollamaAdapter("qwen2.5:7b-instruct")
 * ```
 */
export function ollamaAdapter(
	model: string,
	baseUrl: string = DEFAULT_BASE_URL
): OllamaTextAdapter<string> {
	const adapter = createOllamaChat(model, baseUrl)
	const origStructuredOutput =
		adapter.structuredOutput.bind(adapter)

	adapter.structuredOutput = async (
		options: Parameters<typeof adapter.structuredOutput>[0]
	) => {
		return withTimeout(
			origStructuredOutput(options),
			STRUCTURED_TIMEOUT_MS,
			`Ollama structured output for ${model} timed out after ${STRUCTURED_TIMEOUT_MS / 1000}s`
		)
	}

	return adapter
}

// ── Embedding functions ─────────────────────────────────────────────────────

interface OllamaEmbedResponse {
	model: string
	embeddings: number[][]
}

/**
 * Create a single-text embedding function using Ollama.
 *
 * @example
 * ```ts
 * import { ollamaEmbed } from "@ellie/ai/ollama"
 *
 * const embed = ollamaEmbed("nomic-embed-text")
 * const vector = await embed("Hello world")
 * ```
 */
export function ollamaEmbed(
	model: string,
	baseUrl: string = DEFAULT_BASE_URL
): (text: string) => Promise<number[]> {
	return async (text: string): Promise<number[]> => {
		return withRetry(async () => {
			const response = await fetch(`${baseUrl}/api/embed`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model, input: text })
			})

			if (!response.ok) {
				const body = await response.text()
				throw new Error(
					`Ollama embed failed (${response.status}): ${body}`
				)
			}

			const data =
				(await response.json()) as OllamaEmbedResponse
			if (!data.embeddings?.[0]) {
				throw new Error('Ollama returned no embeddings')
			}
			return data.embeddings[0]
		}, 'embed')
	}
}

/**
 * Create a batch embedding function using Ollama.
 *
 * @example
 * ```ts
 * import { ollamaEmbedBatch } from "@ellie/ai/ollama"
 *
 * const embedBatch = ollamaEmbedBatch("nomic-embed-text")
 * const vectors = await embedBatch(["Hello", "World"])
 * ```
 */
export function ollamaEmbedBatch(
	model: string,
	baseUrl: string = DEFAULT_BASE_URL
): (texts: string[]) => Promise<number[][]> {
	return async (texts: string[]): Promise<number[][]> => {
		if (texts.length === 0) return []

		return withRetry(async () => {
			const response = await fetch(`${baseUrl}/api/embed`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model, input: texts })
			})

			if (!response.ok) {
				const body = await response.text()
				throw new Error(
					`Ollama embed batch failed (${response.status}): ${body}`
				)
			}

			const data =
				(await response.json()) as OllamaEmbedResponse
			if (data.embeddings.length !== texts.length) {
				throw new Error(
					`Embedding count mismatch: expected ${texts.length}, got ${data.embeddings.length}`
				)
			}
			return data.embeddings
		}, 'embed-batch')
	}
}
