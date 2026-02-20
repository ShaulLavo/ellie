/**
 * Tests for dedup.ts — semantic deduplication.
 *
 * Requires a real Hindsight instance (DB + embeddings) but no LLM.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("findDuplicates (via retain with dedupThreshold)", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  it("stores a new fact when no duplicates exist", async () => {
    const result = await t.hs.retain(bankId, "test content", {
      facts: [{ content: "Peter loves hiking", factType: "experience" }],
      dedupThreshold: 0.92,
    })
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0]!.content).toBe("Peter loves hiking")
  })

  it("deduplicates exact same text", async () => {
    // First retain
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Peter loves hiking", factType: "experience" }],
      dedupThreshold: 0.92,
    })

    // Second retain with exact same content
    const result = await t.hs.retain(bankId, "test", {
      facts: [{ content: "Peter loves hiking", factType: "experience" }],
      dedupThreshold: 0.92,
    })

    // Exact same text → same embedding → distance 0 → similarity 1.0 > 0.92 → deduped
    expect(result.memories).toHaveLength(0)
  })

  it("stores when similarity is below threshold", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Peter loves hiking in the mountains", factType: "experience" }],
      dedupThreshold: 0.92,
    })

    // Use a radically different string so our hash-based mock embeddings
    // produce vectors that are clearly dissimilar (mock embeddings are NOT
    // semantic — they're character-frequency based, so strings of similar
    // length and character distribution can look "similar").
    const result = await t.hs.retain(bankId, "test", {
      facts: [{ content: "xyz 123 !@#", factType: "experience" }],
      dedupThreshold: 0.92,
    })

    // Very different content → different embedding → should not be deduped
    expect(result.memories).toHaveLength(1)
  })

  it("disables dedup when threshold is 0", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Peter loves hiking", factType: "experience" }],
      dedupThreshold: 0,
    })

    const result = await t.hs.retain(bankId, "test", {
      facts: [{ content: "Peter loves hiking", factType: "experience" }],
      dedupThreshold: 0,
    })

    // Threshold 0 → dedup disabled → should store
    expect(result.memories).toHaveLength(1)
  })

  it("isolates dedup by bank", async () => {
    const bankId2 = createTestBank(t.hs, "bank-2")

    // Retain in bank 1
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Peter loves hiking", factType: "experience" }],
      dedupThreshold: 0.92,
    })

    // Same content in bank 2 — should NOT be deduped
    const result = await t.hs.retain(bankId2, "test", {
      facts: [{ content: "Peter loves hiking", factType: "experience" }],
      dedupThreshold: 0.92,
    })

    expect(result.memories).toHaveLength(1)
  })
})
