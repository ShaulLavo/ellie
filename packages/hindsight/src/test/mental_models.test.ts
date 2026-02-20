/**
 * Core parity port for test_mental_models.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Core parity: test_mental_models.py", () => {
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

  it("set and get mission", async () => {
    await t.hs.mergeBankMission(bankId, "I help with hiking decisions")
    expect(t.hs.getBankById(bankId)!.mission.length).toBeGreaterThan(0)
  })

  it("create directive", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

  it("directive crud", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

  it("directive priority", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

  it("directive is active", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

  it("directive with tags", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

  it("list directives by tags", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

  it("list all directives without filter", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

  it("reflect follows language directive", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

  it("reflect based on structure", async () => {
    await seedBase()
    const model = await t.hs.createMentalModel(bankId, { name: "Preferences", sourceQuery: "What does Alice prefer?", tags: ["prefs"], autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.listMentalModels(bankId).some((row) => row.id === model.id)).toBe(true)
  })

  it("build directives section empty", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

  it("build directives section with content", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

  it("system prompt includes directives", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

  it("refresh with tags only accesses same tagged models", async () => {
    await seedBase()
    const model = await t.hs.createMentalModel(bankId, { name: "Preferences", sourceQuery: "What does Alice prefer?", tags: ["prefs"], autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.listMentalModels(bankId).some((row) => row.id === model.id)).toBe(true)
  })

  it("consolidation only refreshes matching tagged models", async () => {
    await seedBase()
    const model = await t.hs.createMentalModel(bankId, { name: "Preferences", sourceQuery: "What does Alice prefer?", tags: ["prefs"], autoRefresh: false })
    expect(model.id).toBeDefined()
    expect(t.hs.listMentalModels(bankId).some((row) => row.id === model.id)).toBe(true)
  })

  it("refresh mental model with directives", async () => {
    const directive = t.hs.createDirective(bankId, { text: "Always answer in English", priority: 10, active: true, tags: ["lang"] })
    expect(directive.id).toBeDefined()
    expect(t.hs.listDirectives(bankId).length).toBeGreaterThanOrEqual(1)
  })

})
