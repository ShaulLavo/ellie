/**
 * Ollama embedding functions.
 *
 * Factory functions that return EmbedFunction / EmbedBatchFunction-compatible
 * closures for use with @ellie/hindsight or any consumer that needs embeddings.
 *
 * Uses plain fetch() against Ollama's /api/embed endpoint — no npm dependency.
 */

const DEFAULT_BASE_URL = "http://localhost:11434"

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
  baseUrl: string = DEFAULT_BASE_URL,
): (text: string) => Promise<number[]> {
  return async (text: string): Promise<number[]> => {
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Ollama embed failed (${response.status}): ${body}`)
    }

    const data = (await response.json()) as OllamaEmbedResponse
    if (!data.embeddings?.[0]) {
      throw new Error("Ollama returned no embeddings")
    }
    return data.embeddings[0]
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
  baseUrl: string = DEFAULT_BASE_URL,
): (texts: string[]) => Promise<number[][]> {
  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return []

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Ollama embed batch failed (${response.status}): ${body}`)
    }

    const data = (await response.json()) as OllamaEmbedResponse
    if (data.embeddings.length !== texts.length) {
      throw new Error(
        `Embedding count mismatch: expected ${texts.length}, got ${data.embeddings.length}`,
      )
    }
    return data.embeddings
  }
}
