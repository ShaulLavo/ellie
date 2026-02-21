/**
 * Core parity port for test_batch_chunking.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Core parity: test_batch_chunking.py", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  async function _seedBase() {
    await t.hs.retain(bankId, "seed", {
      facts: [
        { content: "Peter met Alice in June 2024 and planned a hike", factType: "experience", confidence: 0.91, entities: ["Peter", "Alice"], tags: ["seed", "people"], occurredStart: Date.now() - 60 * 86_400_000 },
        { content: "Rain caused the trail to become muddy", factType: "world", confidence: 0.88, entities: ["trail"], tags: ["seed", "weather"] },
        { content: "Alice prefers tea over coffee", factType: "opinion", confidence: 0.85, entities: ["Alice"], tags: ["seed", "preferences"] },
      ],
      documentId: "seed-doc",
      context: "seed context",
      tags: ["seed"],
      consolidate: false,
    })
  }

  it("large batch auto chunks", async () => {
    const result = await t.hs.retainBatch(bankId, ["A".repeat(650_000)], { consolidate: false, documentId: "doc-test_large_batch_auto_chunks" })
    expect(result.length).toBe(1)
    expect(result[0]!.memories.length).toBeGreaterThanOrEqual(1)
    expect(t.hs.listDocuments(bankId).items.length).toBeGreaterThanOrEqual(1)
  })

  it("small batch no chunking", async () => {
    const result = await t.hs.retainBatch(bankId, ["small chunk text"], { consolidate: false, documentId: "doc-test_small_batch_no_chunking" })
    expect(result.length).toBe(1)
    expect(result[0]!.memories.length).toBeGreaterThanOrEqual(1)
    expect(t.hs.listDocuments(bankId).items.length).toBeGreaterThanOrEqual(1)
  })

})
