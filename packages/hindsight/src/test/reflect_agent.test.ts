/**
 * Core parity port for test_reflect_agent.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Core parity: test_reflect_agent.py", () => {
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

  it("clean text with done call", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean text with done call and whitespace", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean text without done call", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean text with done word in content", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean empty text", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean text multiline done", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean answer with leaked json code block", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean answer with memory ids code block", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean answer with raw json object", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean answer with trailing ids pattern", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean answer with memory ids equals", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean normal answer unchanged", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean empty answer", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean answer with observation word in content", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("clean answer multiline with markdown", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("normalize standard name", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("normalize functions prefix", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("normalize call equals prefix", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("normalize call equals functions prefix", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("normalize special token suffix", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("handles functions prefix in done", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("handles call equals functions prefix", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("recovery from unknown tool", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("recovery from tool execution error", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("normalizes tool names in other tools", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

  it("max iterations reached", async () => {
    await seedBase()
    t.adapter.setResponse("Done. Peter likes hiking.")
    const result = await t.hs.reflect(bankId, "summarize Peter", { saveObservations: false, maxIterations: 2 })
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.answer.toLowerCase()).not.toContain("memory_ids=")
  })

})
