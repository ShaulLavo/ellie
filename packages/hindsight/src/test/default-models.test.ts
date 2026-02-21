import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  DEFAULT_EMBED_DIMS,
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  defaultTeiEmbed,
  defaultTeiEmbedBatch,
  defaultTeiRerank,
  resolveModelRuntime,
} from "../default-models"

const ENV_KEYS = [
  "HINDSIGHT_TEI_EMBED_URL",
  "HINDSIGHT_TEI_RERANK_URL",
  "HINDSIGHT_TEI_API_KEY",
  "HINDSIGHT_TEI_RERANK_BATCH_SIZE",
  "HINDSIGHT_TEI_RERANK_MAX_CONCURRENT",
  "HINDSIGHT_API_EMBEDDINGS_TEI_URL",
  "HINDSIGHT_API_RERANKER_TEI_URL",
] as const

function setEnv(key: (typeof ENV_KEYS)[number], value?: string): void {
  if (value == null) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

describe("default model wiring", () => {
  const originalFetch = globalThis.fetch
  const originalEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key)
      if (value == null) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it("exports expected default model constants", () => {
    expect(DEFAULT_EMBED_MODEL).toBe("BAAI/bge-small-en-v1.5")
    expect(DEFAULT_RERANK_MODEL).toBe("cross-encoder/ms-marco-MiniLM-L-6-v2")
    expect(DEFAULT_EMBED_DIMS).toBe(384)
  })

  it("resolveModelRuntime enables built-in TEI defaults when embed is not provided", () => {
    const runtime = resolveModelRuntime({})
    expect(runtime.usesDefaultEmbed).toBe(true)
    expect(runtime.embeddingDimensions).toBe(384)
    expect(runtime.embedBatch).toBeDefined()
    expect(runtime.rerank).toBeDefined()
  })

  it("resolveModelRuntime keeps custom embed behavior and does not inject rerank", () => {
    const customEmbed = async () => [0.1, 0.2, 0.3]
    const runtime = resolveModelRuntime({
      embed: customEmbed,
      embeddingDimensions: 3,
    })
    expect(runtime.usesDefaultEmbed).toBe(false)
    expect(runtime.embeddingDimensions).toBe(3)
    expect(runtime.rerank).toBeUndefined()
  })

  it("throws on dimension mismatch with built-in default embeddings", () => {
    expect(() =>
      resolveModelRuntime({
        embeddingDimensions: 1536,
      }),
    ).toThrow("requires embeddingDimensions=384")
  })

  it("uses primary embed URL env and auth header", async () => {
    setEnv("HINDSIGHT_TEI_EMBED_URL", "http://embed.local:9090")
    setEnv("HINDSIGHT_TEI_API_KEY", "secret-token")

    let calledUrl = ""
    let calledBody = ""
    let authHeader = ""

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calledUrl = String(input)
      calledBody = String(init?.body ?? "")
      authHeader = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "")
      return new Response(JSON.stringify([[0.01, 0.02, 0.03]]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const vector = await defaultTeiEmbed("hello")

    expect(calledUrl).toBe("http://embed.local:9090/embed")
    expect(calledBody).toContain("\"inputs\":[\"hello\"]")
    expect(authHeader).toBe("Bearer secret-token")
    expect(vector).toEqual([0.01, 0.02, 0.03])
  })

  it("falls back to python-compatible embed URL env name", async () => {
    setEnv("HINDSIGHT_API_EMBEDDINGS_TEI_URL", "http://legacy-embed:8088")

    let calledUrl = ""
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input)
      return new Response(JSON.stringify([[0.11], [0.22]]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const vectors = await defaultTeiEmbedBatch(["a", "b"])
    expect(calledUrl).toBe("http://legacy-embed:8088/embed")
    expect(vectors).toEqual([[0.11], [0.22]])
  })

  it("uses primary rerank URL, batching, and returns score-aligned output", async () => {
    setEnv("HINDSIGHT_TEI_RERANK_URL", "http://rerank.local:8181")
    setEnv("HINDSIGHT_TEI_RERANK_BATCH_SIZE", "2")
    setEnv("HINDSIGHT_TEI_RERANK_MAX_CONCURRENT", "1")

    const calls: Array<{ url: string; texts: string[] }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        texts: string[]
      }
      calls.push({ url: String(input), texts: body.texts ?? [] })
      const result = (body.texts ?? []).map((_, index) => ({
        index,
        score: 100 - index,
      }))
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    const scores = await defaultTeiRerank("query", ["a", "b", "c"])
    expect(calls.length).toBe(2)
    expect(calls[0]!.url).toBe("http://rerank.local:8181/rerank")
    expect(calls[1]!.url).toBe("http://rerank.local:8181/rerank")
    expect(scores).toHaveLength(3)
    expect(scores[0]).toBe(100)
    expect(scores[1]).toBe(99)
    expect(scores[2]).toBe(100)
  })

  it("falls back to python-compatible rerank URL env name", async () => {
    setEnv("HINDSIGHT_API_RERANKER_TEI_URL", "http://legacy-rerank:9191")

    let calledUrl = ""
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calledUrl = String(input)
      const body = JSON.parse(String(init?.body ?? "{}")) as { texts: string[] }
      const result = (body.texts ?? []).map((_, index) => ({ index, score: 0.5 }))
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    await defaultTeiRerank("q", ["doc"])
    expect(calledUrl).toBe("http://legacy-rerank:9191/rerank")
  })

  it("fails fast with clear error when embed endpoint errors", async () => {
    setEnv("HINDSIGHT_TEI_EMBED_URL", "http://embed-down:8080")

    globalThis.fetch = (async () =>
      new Response("server exploded", { status: 500 })) as typeof fetch

    await expect(defaultTeiEmbed("x")).rejects.toThrow(
      "Default TEI embedding failed (BAAI/bge-small-en-v1.5) at http://embed-down:8080/embed",
    )
  })

  it("fails fast with clear error when rerank endpoint errors", async () => {
    setEnv("HINDSIGHT_TEI_RERANK_URL", "http://rerank-down:8181")

    globalThis.fetch = (async () =>
      new Response("broken", { status: 500 })) as typeof fetch

    await expect(defaultTeiRerank("q", ["d"])).rejects.toThrow(
      "Default TEI rerank failed (cross-encoder/ms-marco-MiniLM-L-6-v2) at http://rerank-down:8181/rerank",
    )
  })
})

