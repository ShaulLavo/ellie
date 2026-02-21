import type {
  EmbedBatchFunction,
  EmbedFunction,
  HindsightConfig,
  RerankFunction,
} from "./types"

export const DEFAULT_EMBED_MODEL = "BAAI/bge-small-en-v1.5"
export const DEFAULT_RERANK_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"
export const DEFAULT_EMBED_DIMS = 384

const DEFAULT_EMBED_URL = "http://localhost:8080"
const DEFAULT_RERANK_URL = "http://localhost:8081"
const DEFAULT_RERANK_BATCH_SIZE = 128
const DEFAULT_RERANK_MAX_CONCURRENT = 8

const PRIMARY_EMBED_URL_ENV = "HINDSIGHT_TEI_EMBED_URL"
const PRIMARY_RERANK_URL_ENV = "HINDSIGHT_TEI_RERANK_URL"
const API_KEY_ENV = "HINDSIGHT_TEI_API_KEY"
const RERANK_BATCH_SIZE_ENV = "HINDSIGHT_TEI_RERANK_BATCH_SIZE"
const RERANK_MAX_CONCURRENT_ENV = "HINDSIGHT_TEI_RERANK_MAX_CONCURRENT"

const PYTHON_EMBED_URL_ENV = "HINDSIGHT_API_EMBEDDINGS_TEI_URL"
const PYTHON_RERANK_URL_ENV = "HINDSIGHT_API_RERANKER_TEI_URL"

interface ResolvedDefaultModelConfig {
  embedUrl: string
  rerankUrl: string
  apiKey?: string
  rerankBatchSize: number
  rerankMaxConcurrent: number
}

export interface ResolvedModelRuntime {
  embed: EmbedFunction
  embedBatch?: EmbedBatchFunction
  rerank?: RerankFunction
  embeddingDimensions: number
  usesDefaultEmbed: boolean
}

function readEnvValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const processValue = typeof process !== "undefined" ? process.env[key] : undefined
    const bunValue = typeof Bun !== "undefined" ? Bun.env[key] : undefined
    const value = processValue ?? bunValue
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return parsed
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

function resolveDefaultModelConfig(): ResolvedDefaultModelConfig {
  const embedUrl = trimTrailingSlash(
    readEnvValue(PRIMARY_EMBED_URL_ENV, PYTHON_EMBED_URL_ENV) ?? DEFAULT_EMBED_URL,
  )
  const rerankUrl = trimTrailingSlash(
    readEnvValue(PRIMARY_RERANK_URL_ENV, PYTHON_RERANK_URL_ENV) ?? DEFAULT_RERANK_URL,
  )
  return {
    embedUrl,
    rerankUrl,
    apiKey: readEnvValue(API_KEY_ENV),
    rerankBatchSize: parsePositiveInt(
      readEnvValue(RERANK_BATCH_SIZE_ENV),
      DEFAULT_RERANK_BATCH_SIZE,
    ),
    rerankMaxConcurrent: parsePositiveInt(
      readEnvValue(RERANK_MAX_CONCURRENT_ENV),
      DEFAULT_RERANK_MAX_CONCURRENT,
    ),
  }
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  return headers
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `status ${response.status}: ${text || response.statusText || "request failed"}`,
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`invalid JSON response: ${text.slice(0, 300)}`)
  }
}

function assertEmbeddingVectors(
  payload: unknown,
  expectedCount: number,
): number[][] {
  if (!Array.isArray(payload)) {
    throw new Error("expected embedding response to be an array")
  }
  const vectors = payload as unknown[]
  if (vectors.length !== expectedCount) {
    throw new Error(
      `embedding response size mismatch: expected ${expectedCount}, got ${vectors.length}`,
    )
  }
  return vectors.map((vector, index) => {
    if (!Array.isArray(vector)) {
      throw new Error(`embedding vector ${index} is not an array`)
    }
    const numeric = vector.map((value) => Number(value))
    if (numeric.some((value) => !Number.isFinite(value))) {
      throw new Error(`embedding vector ${index} contains non-numeric values`)
    }
    return numeric
  })
}

interface TeiRerankItem {
  index: number
  score: number
}

function assertRerankItems(
  payload: unknown,
  expectedCount: number,
): TeiRerankItem[] {
  const list = Array.isArray(payload)
    ? payload
    : (payload as { results?: unknown[] })?.results
  if (!Array.isArray(list)) {
    throw new Error("expected rerank response to be an array")
  }
  if (list.length !== expectedCount) {
    throw new Error(
      `rerank response size mismatch: expected ${expectedCount}, got ${list.length}`,
    )
  }

  return list.map((item, idx) => {
    const value = item as { index?: unknown; score?: unknown }
    const index = Number(value.index)
    const score = Number(value.score)
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) {
      throw new Error(`invalid rerank index at position ${idx}: ${String(value.index)}`)
    }
    if (!Number.isFinite(score)) {
      throw new Error(`invalid rerank score at position ${idx}: ${String(value.score)}`)
    }
    return { index, score }
  })
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return []
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = Array.from({ length: items.length }) as R[]
  let cursor = 0
  const laneCount = Math.max(1, Math.min(concurrency, items.length))

  const lanes = Array.from({ length: laneCount }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  })

  await Promise.all(lanes)
  return results
}

export const defaultTeiEmbed: EmbedFunction = async (text) => {
  const config = resolveDefaultModelConfig()
  const endpoint = `${config.embedUrl}/embed`
  const response = await fetch(endpoint, {
    method: "POST",
    headers: buildHeaders(config.apiKey),
    body: JSON.stringify({ inputs: [text] }),
  })
  let payload: unknown
  try {
    payload = await parseJsonResponse(response)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Default TEI embedding failed (${DEFAULT_EMBED_MODEL}) at ${endpoint}: ${message}`,
    )
  }
  const vectors = assertEmbeddingVectors(payload, 1)
  return vectors[0]!
}

export const defaultTeiEmbedBatch: EmbedBatchFunction = async (texts) => {
  if (texts.length === 0) return []
  const config = resolveDefaultModelConfig()
  const endpoint = `${config.embedUrl}/embed`
  const response = await fetch(endpoint, {
    method: "POST",
    headers: buildHeaders(config.apiKey),
    body: JSON.stringify({ inputs: texts }),
  })
  let payload: unknown
  try {
    payload = await parseJsonResponse(response)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Default TEI embedding batch failed (${DEFAULT_EMBED_MODEL}) at ${endpoint}: ${message}`,
    )
  }
  return assertEmbeddingVectors(payload, texts.length)
}

export const defaultTeiRerank: RerankFunction = async (query, documents) => {
  if (documents.length === 0) return []
  const config = resolveDefaultModelConfig()
  const endpoint = `${config.rerankUrl}/rerank`

  const grouped = chunk(
    documents.map((text, index) => ({ index, text })),
    config.rerankBatchSize,
  )
  const scores = Array.from({ length: documents.length }, () => 0)

  await runWithConcurrency(
    grouped,
    config.rerankMaxConcurrent,
    async (items) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: buildHeaders(config.apiKey),
        body: JSON.stringify({
          query,
          texts: items.map((item) => item.text),
          return_text: false,
        }),
      })

      let payload: unknown
      try {
        payload = await parseJsonResponse(response)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          `Default TEI rerank failed (${DEFAULT_RERANK_MODEL}) at ${endpoint}: ${message}`,
        )
      }

      const batchScores = assertRerankItems(payload, items.length)
      for (const entry of batchScores) {
        const memoryIndex = items[entry.index]!.index
        scores[memoryIndex] = entry.score
      }
    },
  )

  return scores
}

export function resolveModelRuntime(
  config: Pick<HindsightConfig, "embed" | "embedBatch" | "rerank" | "embeddingDimensions">,
): ResolvedModelRuntime {
  const usesDefaultEmbed = !config.embed
  if (
    usesDefaultEmbed &&
    config.embeddingDimensions != null &&
    config.embeddingDimensions !== DEFAULT_EMBED_DIMS
  ) {
    throw new Error(
      `Default embedding model ${DEFAULT_EMBED_MODEL} requires embeddingDimensions=${DEFAULT_EMBED_DIMS}. ` +
      `Received ${config.embeddingDimensions}. Provide a custom embed function for other dimensions.`,
    )
  }

  const embeddingDimensions =
    config.embeddingDimensions ??
    (usesDefaultEmbed ? DEFAULT_EMBED_DIMS : 1536)

  const embed = config.embed ?? defaultTeiEmbed
  const embedBatch =
    config.embedBatch ??
    (usesDefaultEmbed ? defaultTeiEmbedBatch : undefined)
  const rerank =
    config.rerank ??
    (usesDefaultEmbed ? defaultTeiRerank : undefined)

  return {
    embed,
    embedBatch,
    rerank,
    embeddingDimensions,
    usesDefaultEmbed,
  }
}

