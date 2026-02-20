/**
 * Shared test utilities for @ellie/hindsight tests.
 *
 * Equivalent of conftest.py from the original Hindsight project.
 * Provides a factory for creating test Hindsight instances with temp DBs
 * and pre-generated real embeddings (nomic-embed-text via Ollama).
 */

import { tmpdir } from "os"
import { join } from "path"
import { rmSync, readFileSync } from "fs"
import { describe } from "bun:test"
import { anthropicText } from "@tanstack/ai-anthropic"
import { Hindsight } from "../hindsight"
import type { HindsightConfig } from "../types"
import { createMockAdapter, type MockAdapter } from "./mock-adapter"

// ── Load pre-generated embeddings fixture ────────────────────────────────────
//
// Real embeddings from nomic-embed-text (768 dims) generated via:
//   bun run generate-embeddings
//
// Falls back to hash-based embeddings if fixture is missing.

let EMBEDDING_FIXTURE: Record<string, number[]> = {}
try {
  const fixturePath = join(import.meta.dir, "fixtures", "embeddings.json")
  EMBEDDING_FIXTURE = JSON.parse(readFileSync(fixturePath, "utf-8"))
} catch {
  // Fixture not yet generated — fall back to hash-based embeddings
}

const HAS_REAL_EMBEDDINGS = Object.keys(EMBEDDING_FIXTURE).length > 0

// ── Constants ────────────────────────────────────────────────────────────────

export const EMBED_DIMS = HAS_REAL_EMBEDDINGS ? 768 : 16
export const EXTRACTION_TEST_MODE = process.env.HINDSIGHT_EXTRACTION_TEST_MODE ?? "deterministic"
export const EXTRACTION_TEST_CANONICAL_TIMEZONE = "Asia/Jerusalem"

export function useRealLLMExtractionTests(): boolean {
  return EXTRACTION_TEST_MODE === "real-llm"
}

// ── Embedding function ───────────────────────────────────────────────────────

/**
 * Hash-based fallback embedding (NOT semantically meaningful).
 * Used when a text is not found in the pre-generated fixture.
 */
function hashEmbed(text: string, dims: number): number[] {
  const vec = Array.from<number>({ length: dims }).fill(0)
  for (let i = 0; i < text.length; i++) {
    vec[i % dims] += text.charCodeAt(i) / 1000
  }
  const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0))
  return norm > 0 ? vec.map((v: number) => v / norm) : vec
}

/**
 * Embedding function backed by pre-generated real embeddings.
 *
 * With the fixture loaded (default):
 * - Returns real nomic-embed-text vectors for known strings
 * - Cosine similarity between "Peter" and "Peter works at Acme Corp" is high
 * - Semantic search and graph seed resolution work correctly
 *
 * Without fixture or for unknown strings:
 * - Falls back to deterministic hash-based embeddings
 * - Same text → same vector, but similarity is not semantically meaningful
 */
export function mockEmbed(text: string): Promise<number[]> {
  const precomputed = EMBEDDING_FIXTURE[text]
  if (precomputed) {
    return Promise.resolve(precomputed)
  }
  return Promise.resolve(hashEmbed(text, EMBED_DIMS))
}

// ── Test Hindsight factory ──────────────────────────────────────────────────

export interface TestHindsight {
  hs: Hindsight
  adapter: MockAdapter
  dbPath: string
  cleanup: () => void
}

export interface RealLLMTestHindsight {
  hs: Hindsight
  dbPath: string
  cleanup: () => void
}

/**
 * Create a Hindsight instance backed by a temporary SQLite database.
 *
 * Returns the instance, the mock adapter (for inspecting/configuring LLM
 * responses), and a cleanup function that closes the DB and removes the file.
 */
export function createTestHindsight(
  overrides?: Partial<HindsightConfig>,
): TestHindsight {
  const dbPath = join(
    tmpdir(),
    `hindsight-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )
  const adapter = createMockAdapter()

  const hs = new Hindsight({
    dbPath,
    embed: mockEmbed,
    embeddingDimensions: EMBED_DIMS,
    adapter: adapter as unknown as HindsightConfig["adapter"],
    ...overrides,
  })

  const cleanup = () => {
    try {
      hs.close()
    } catch {
      // already closed
    }
    try {
      rmSync(dbPath, { force: true })
      rmSync(dbPath + "-wal", { force: true })
      rmSync(dbPath + "-shm", { force: true })
    } catch {
      // file may not exist
    }
  }

  return { hs, adapter, dbPath, cleanup }
}

// ── Real LLM test factory ───────────────────────────────────────────────────

export const HAS_ANTHROPIC_KEY = !!process.env.ANTHROPIC_API_KEY

/** Use instead of `describe` for test blocks that require a real LLM (Anthropic API key). */
export const describeWithLLM = HAS_ANTHROPIC_KEY ? describe : describe.skip

export interface RealTestHindsight {
  hs: Hindsight
  dbPath: string
  cleanup: () => void
}

/**
 * Create a Hindsight instance with a real Anthropic adapter (claude-haiku-4-5).
 *
 * Requires ANTHROPIC_API_KEY in the environment. Use `describeWithLLM` to skip
 * entire test blocks when the key is not available.
 */
export function createRealTestHindsight(
  overrides?: Partial<HindsightConfig>,
): RealTestHindsight {
  const dbPath = join(
    tmpdir(),
    `hindsight-test-real-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )
  const adapter = anthropicText("claude-haiku-4-5")

  const hs = new Hindsight({
    dbPath,
    embed: mockEmbed,
    embeddingDimensions: EMBED_DIMS,
    adapter,
    ...overrides,
  })

  const cleanup = () => {
    try {
      hs.close()
    } catch {
      // already closed
    }
    try {
      rmSync(dbPath, { force: true })
      rmSync(dbPath + "-wal", { force: true })
      rmSync(dbPath + "-shm", { force: true })
    } catch {
      // file may not exist
    }
  }

  return { hs, dbPath, cleanup }
}

/**
 * Create a Hindsight instance for real-LLM extraction tests.
 *
 * Uses the package default adapter (Anthropic) unless caller overrides it.
 * Requires valid provider credentials in the environment when executed.
 */
export function createRealLLMTestHindsight(
  overrides?: Partial<HindsightConfig>,
): RealLLMTestHindsight {
  const dbPath = join(
    tmpdir(),
    `hindsight-real-llm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )

  const hs = new Hindsight({
    dbPath,
    embed: mockEmbed,
    embeddingDimensions: EMBED_DIMS,
    ...overrides,
  })

  const cleanup = () => {
    try {
      hs.close()
    } catch {
      // already closed
    }
    try {
      rmSync(dbPath, { force: true })
      rmSync(dbPath + "-wal", { force: true })
      rmSync(dbPath + "-shm", { force: true })
    } catch {
      // file may not exist
    }
  }

  return { hs, dbPath, cleanup }
}

/**
 * Standard "implement me" throw for tests that need missing modules or real LLM.
 * Throws an error with a description and a reference to the Python source test.
 */
export function implementMe(description: string, pythonRef: string): never {
  throw new Error(`implement me: ${description} — see ${pythonRef}`)
}

/**
 * Create a bank in the test Hindsight instance and return its ID.
 */
export function createTestBank(
  hs: Hindsight,
  name?: string,
  description?: string,
): string {
  const bank = hs.createBank(
    name ?? `test-bank-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    description ? { description } : undefined,
  )
  return bank.id
}
