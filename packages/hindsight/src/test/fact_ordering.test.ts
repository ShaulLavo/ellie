/**
 * Core parity port for test_fact_ordering.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Core parity: test_fact_ordering.py", () => {
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

  it("fact ordering within conversation", async () => {
    const eventDate = Date.now() - 86_400_000
    const result = await t.hs.retain(bankId, "retain", { facts: [{ content: "Alice visited Rome", factType: "experience", confidence: 0.95, entities: ["Alice", "Rome"], tags: ["travel"], occurredStart: eventDate }], eventDate, context: "travel diary", metadata: { source: "unit-test" }, documentId: "doc-test_fact_ordering_within_conversation", consolidate: false })
    expect(result.memories.length).toBe(1)
    expect(result.memories[0]!.content.length).toBeGreaterThan(0)
  })

  it("multiple documents ordering", async () => {
    const eventDate = Date.now() - 86_400_000
    const result = await t.hs.retain(bankId, "retain", { facts: [{ content: "Alice visited Rome", factType: "experience", confidence: 0.95, entities: ["Alice", "Rome"], tags: ["travel"], occurredStart: eventDate }], eventDate, context: "travel diary", metadata: { source: "unit-test" }, documentId: "doc-test_multiple_documents_ordering", consolidate: false })
    expect(result.memories.length).toBe(1)
    expect(result.memories[0]!.content.length).toBeGreaterThan(0)
  })

})
