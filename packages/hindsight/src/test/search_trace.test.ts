/**
 * Core parity port for test_search_trace.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Core parity: test_search_trace.py", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  async function seedBase() {
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

  it("search with trace", async () => {
    await seedBase()
    const result = await t.hs.recall(bankId, "hiking", { enableTrace: true })
    expect(result.trace).toBeDefined()
    expect(result.trace!.query).toBe("hiking")
    expect(result.trace!.phaseMetrics.length).toBeGreaterThan(0)
  })

  it("search without trace", async () => {
    await seedBase()
    const result = await t.hs.recall(bankId, "hiking", { enableTrace: true })
    expect(result.trace).toBeDefined()
    expect(result.trace!.query).toBe("hiking")
    expect(result.trace!.phaseMetrics.length).toBeGreaterThan(0)
  })

})
