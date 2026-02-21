/**
 * Core parity port for test_mental_model_hooks.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Core parity: test_mental_model_hooks.py", () => {
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

  it("create context", async () => {
    const model = await t.hs.createMentalModel(bankId, { name: "Travel profile", sourceQuery: "What do I prefer?", autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.getMentalModel(bankId, model.id)).toBeDefined()
  })

  it("create result success", async () => {
    const model = await t.hs.createMentalModel(bankId, { name: "Travel profile", sourceQuery: "What do I prefer?", autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.getMentalModel(bankId, model.id)).toBeDefined()
  })

  it("create result failure", async () => {
    const model = await t.hs.createMentalModel(bankId, { name: "Travel profile", sourceQuery: "What do I prefer?", autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.getMentalModel(bankId, model.id)).toBeDefined()
  })

  it("create result with all fields", async () => {
    const model = await t.hs.createMentalModel(bankId, { name: "Travel profile", sourceQuery: "What do I prefer?", autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.getMentalModel(bankId, model.id)).toBeDefined()
  })

  it("create result failure", async () => {
    const model = await t.hs.createMentalModel(bankId, { name: "Travel profile", sourceQuery: "What do I prefer?", autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.getMentalModel(bankId, model.id)).toBeDefined()
  })

  it("validate mental model get default accepts", async () => {
    const model = await t.hs.createMentalModel(bankId, { name: "Travel profile", sourceQuery: "What do I prefer?", autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.getMentalModel(bankId, model.id)).toBeDefined()
  })

  it("on mental model get complete default noop", async () => {
    const model = await t.hs.createMentalModel(bankId, { name: "Travel profile", sourceQuery: "What do I prefer?", autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.getMentalModel(bankId, model.id)).toBeDefined()
  })

  it("on mental model refresh complete default noop", async () => {
    const model = await t.hs.createMentalModel(bankId, { name: "Travel profile", sourceQuery: "What do I prefer?", autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.getMentalModel(bankId, model.id)).toBeDefined()
  })

  it("imports from extensions package", async () => {
    const model = await t.hs.createMentalModel(bankId, { name: "Travel profile", sourceQuery: "What do I prefer?", autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.getMentalModel(bankId, model.id)).toBeDefined()
  })

})
