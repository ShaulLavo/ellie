/**
 * Shared test utilities for @ellie/hindsight tests.
 *
 * Equivalent of conftest.py from the original Hindsight project.
 * Provides a factory for creating test Hindsight instances with temp DBs
 * and deterministic (non-semantic) mock embeddings.
 */

import { tmpdir } from "os"
import { join } from "path"
import { rmSync } from "fs"
import { Hindsight } from "../hindsight"
import type { HindsightConfig, EmbedFunction } from "../types"
import { createMockAdapter, type MockAdapter } from "./mock-adapter"

// ── Constants ────────────────────────────────────────────────────────────────

export const EMBED_DIMS = 16

// ── Mock embed function ──────────────────────────────────────────────────────

/**
 * Deterministic hash-based embedding function.
 *
 * NOT semantically meaningful — the same text always produces the same
 * vector, and different texts produce different vectors, but similarity
 * between vectors does NOT correlate with semantic similarity.
 *
 * Sufficient for testing:
 * - Dedup thresholds (exact same text → identical vector → distance 0)
 * - Vector storage / retrieval plumbing
 * - KNN search mechanics
 */
export function mockEmbed(text: string): Promise<number[]> {
  const vec = new Array(EMBED_DIMS).fill(0)
  for (let i = 0; i < text.length; i++) {
    vec[i % EMBED_DIMS] += text.charCodeAt(i) / 1000
  }
  // Normalize to unit vector
  const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0))
  return Promise.resolve(norm > 0 ? vec.map((v: number) => v / norm) : vec)
}

// ── Test Hindsight factory ──────────────────────────────────────────────────

export interface TestHindsight {
  hs: Hindsight
  adapter: MockAdapter
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
