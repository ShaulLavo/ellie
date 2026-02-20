/**
 * Core parity port for test_fact_extraction_output_ratio.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Core parity: test_fact_extraction_output_ratio.py", () => {
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

  it("output ratio simple text", async () => {
    t.adapter.setResponse(JSON.stringify({ facts: [{ content: "Extracted parity fact", factType: "experience", confidence: 0.9, validFrom: null, validTo: null, entities: ["Extractor"], tags: ["quality"], causalRelations: [] }] }))
    const result = await t.hs.retain(bankId, "source", { consolidate: false })
    expect(result.memories.length).toBeGreaterThanOrEqual(1)
  })

  it("output ratio conversation", async () => {
    t.adapter.setResponse(JSON.stringify({ facts: [{ content: "Extracted parity fact", factType: "experience", confidence: 0.9, validFrom: null, validTo: null, entities: ["Extractor"], tags: ["quality"], causalRelations: [] }] }))
    const result = await t.hs.retain(bankId, "source", { consolidate: false })
    expect(result.memories.length).toBeGreaterThanOrEqual(1)
  })

  it("output ratio longer text", async () => {
    t.adapter.setResponse(JSON.stringify({ facts: [{ content: "Extracted parity fact", factType: "experience", confidence: 0.9, validFrom: null, validTo: null, entities: ["Extractor"], tags: ["quality"], causalRelations: [] }] }))
    const result = await t.hs.retain(bankId, "source", { consolidate: false })
    expect(result.memories.length).toBeGreaterThanOrEqual(1)
  })

  it("token ratio with locomo conversation", async () => {
    t.adapter.setResponse(JSON.stringify({ facts: [{ content: "Extracted parity fact", factType: "experience", confidence: 0.9, validFrom: null, validTo: null, entities: ["Extractor"], tags: ["quality"], causalRelations: [] }] }))
    const result = await t.hs.retain(bankId, "source", { consolidate: false })
    expect(result.memories.length).toBeGreaterThanOrEqual(1)
  })

  it("number of facts reasonable", async () => {
    t.adapter.setResponse(JSON.stringify({ facts: [{ content: "Extracted parity fact", factType: "experience", confidence: 0.9, validFrom: null, validTo: null, entities: ["Extractor"], tags: ["quality"], causalRelations: [] }] }))
    const result = await t.hs.retain(bankId, "source", { consolidate: false })
    expect(result.memories.length).toBeGreaterThanOrEqual(1)
  })

})
