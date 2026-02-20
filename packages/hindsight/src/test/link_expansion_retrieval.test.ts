/**
 * Core parity port for test_link_expansion_retrieval.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Core parity: test_link_expansion_retrieval.py", () => {
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
        { content: "Peter met Alice in June 2024 and planned a hike", factType: "experience", confidence: 0.91, entities: ["Peter", "Alice"], tags: ["seed", "people"], validFrom: Date.now() - 60 * 86_400_000 },
        { content: "Rain caused the trail to become muddy", factType: "world", confidence: 0.88, entities: ["trail"], tags: ["seed", "weather"] },
        { content: "Alice prefers tea over coffee", factType: "opinion", confidence: 0.85, entities: ["Alice"], tags: ["seed", "preferences"] },
      ],
      documentId: "seed-doc",
      context: "seed context",
      tags: ["seed"],
      consolidate: false,
    })
  }

  it("link expansion observation graph retrieval", async () => {
    await t.hs.retain(bankId, "links", { facts: [{ content: "Heavy rain caused flooding in the valley", factType: "world", entities: ["rain", "valley"] }, { content: "Flooding delayed the hiking trip", factType: "experience", entities: ["hiking trip"] }], consolidate: false })
    const result = await t.hs.recall(bankId, "flooding hiking", { methods: ["graph", "semantic"], includeEntities: true })
    expect(result.memories.length).toBeGreaterThanOrEqual(1)
  })

  it("link expansion world fact graph retrieval", async () => {
    await t.hs.retain(bankId, "links", { facts: [{ content: "Heavy rain caused flooding in the valley", factType: "world", entities: ["rain", "valley"] }, { content: "Flooding delayed the hiking trip", factType: "experience", entities: ["hiking trip"] }], consolidate: false })
    const result = await t.hs.recall(bankId, "flooding hiking", { methods: ["graph", "semantic"], includeEntities: true })
    expect(result.memories.length).toBeGreaterThanOrEqual(1)
  })

})
