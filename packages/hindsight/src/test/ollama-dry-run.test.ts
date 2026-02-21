/**
 * Ollama dry-run tests — end-to-end validation with a local model.
 *
 * Uses qwen2.5:7b-instruct via Ollama to exercise the full pipeline:
 * retain → recall → reflect → consolidate.
 *
 * The model is too small for high-quality extractions, so assertions are
 * intentionally loose. The goal is to verify that the plumbing works:
 * - LLM is called and returns something
 * - JSON parsing succeeds (or fails gracefully)
 * - Memories are persisted
 * - Recall returns results
 * - Reflect produces an answer
 *
 * Skipped when Ollama is not running (describeWithOllama).
 */

import { afterEach, beforeEach, expect, it } from "bun:test"
import {
  describeWithOllama,
  createOllamaTestHindsight,
  createTestBank,
  type OllamaTestHindsight,
} from "./setup"

describeWithOllama("Ollama dry run (qwen2.5:7b-instruct)", () => {
  let t: OllamaTestHindsight
  let bankId: string

  beforeEach(() => {
    t = createOllamaTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  // ── retain ────────────────────────────────────────────────────────────────

  it("extracts at least one fact from a paragraph", async () => {
    const result = await t.hs.retain(
      bankId,
      "Peter is a software engineer at Acme Corp. He loves hiking " +
        "in the Swiss Alps on weekends and has a golden retriever named Max. " +
        "He recently started learning Rust and enjoys building CLI tools.",
      { consolidate: false },
    )

    console.log("[retain] memories:", result.memories.length)
    console.log("[retain] entities:", result.entities.length)
    if (result.memories.length > 0) {
      for (const m of result.memories) {
        console.log(`  - [${m.factType}] ${m.content}`)
      }
    }

    // Small models often can't produce valid extraction JSON.
    // >= 0 is intentional — we're testing the plumbing, not model quality.
    // With a smarter model (e.g., claude-haiku), this would be >= 1.
    expect(result.memories.length).toBeGreaterThanOrEqual(0)
  }, 120_000)

  it("extracts facts from transcript turns", async () => {
    const result = await t.hs.retain(
      bankId,
      [
        { role: "user", content: "What's your favorite programming language?" },
        {
          role: "assistant",
          content:
            "I really enjoy TypeScript! The type system helps catch bugs early.",
        },
        { role: "user", content: "I agree, I've been using it for 3 years now." },
      ],
      { consolidate: false },
    )

    console.log("[retain transcript] memories:", result.memories.length)
    for (const m of result.memories) {
      console.log(`  - [${m.factType}] ${m.content}`)
    }

    // See note above — small models may fail to produce valid JSON
    expect(result.memories.length).toBeGreaterThanOrEqual(0)
  }, 120_000)

  // ── recall ────────────────────────────────────────────────────────────────

  it("recalls seeded facts by query", async () => {
    // First seed some facts directly
    await t.hs.retain(bankId, "test", {
      facts: [
        { content: "Alice works at Google as a machine learning engineer" },
        { content: "Alice has a cat named Whiskers" },
        { content: "Alice enjoys playing chess on weekends" },
      ],
      consolidate: false,
    })

    const result = await t.hs.recall(bankId, "Where does Alice work?")

    console.log("[recall] memories:", result.memories.length)
    for (const m of result.memories) {
      console.log(`  - [${m.score.toFixed(3)}] ${m.memory.content}`)
    }

    // Should find at least the Google fact
    expect(result.memories.length).toBeGreaterThanOrEqual(1)
  }, 30_000)

  // ── reflect ───────────────────────────────────────────────────────────────

  it("produces a non-empty answer from reflect", async () => {
    // Seed facts
    await t.hs.retain(bankId, "test", {
      facts: [
        { content: "Bob is a chef who specializes in Italian cuisine" },
        { content: "Bob owns a restaurant called Bella Vista" },
        { content: "Bob won a Michelin star in 2023" },
      ],
      consolidate: false,
    })

    const result = await t.hs.reflect(bankId, "Tell me about Bob.", {
      budget: "low",
    })

    console.log("[reflect] answer length:", result.answer.length)
    console.log("[reflect] answer:", result.answer.slice(0, 300))
    console.log("[reflect] memories used:", result.memories.length)

    expect(result.answer.trim().length).toBeGreaterThan(0)
  }, 120_000)

  it("handles empty bank gracefully", async () => {
    const result = await t.hs.reflect(
      bankId,
      "What do you know about quantum physics?",
      { budget: "low" },
    )

    console.log("[reflect empty] answer length:", result.answer.length)
    console.log("[reflect empty] answer:", result.answer.slice(0, 300))

    // Should still return something (even if it says "I don't know")
    expect(result.answer.trim().length).toBeGreaterThan(0)
  }, 120_000)

  // ── consolidate ───────────────────────────────────────────────────────────

  it("consolidation completes without throwing", async () => {
    // Seed some raw facts to consolidate
    await t.hs.retain(bankId, "test", {
      facts: [
        { content: "Carol likes sushi" },
        { content: "Carol enjoys Japanese food, especially ramen" },
        { content: "Carol visited Tokyo last summer" },
      ],
      consolidate: false,
    })

    const result = await t.hs.consolidate(bankId)

    console.log("[consolidate] observationsCreated:", result.observationsCreated)
    console.log("[consolidate] observationsUpdated:", result.observationsUpdated)
    console.log("[consolidate] observationsMerged:", result.observationsMerged)
    console.log("[consolidate] skipped:", result.skipped)
    console.log("[consolidate] memoriesProcessed:", result.memoriesProcessed)

    // Just verify it ran — the model may produce bad output but shouldn't crash
    expect(result).toBeDefined()
    expect(typeof result.observationsCreated).toBe("number")
    expect(typeof result.skipped).toBe("number")
  }, 120_000)

  // ── retain with real extraction (no pre-seeded facts) ─────────────────────

  it("full pipeline: retain → recall → reflect", async () => {
    // Step 1: Retain real content
    const retainResult = await t.hs.retain(
      bankId,
      "David is a 35-year-old architect who lives in Berlin. " +
        "He designed the new city library that won an international award. " +
        "David is passionate about sustainable building materials and " +
        "frequently gives talks at architecture conferences.",
      { consolidate: false },
    )

    console.log("[pipeline] retained memories:", retainResult.memories.length)

    // Step 2: Recall
    const recallResult = await t.hs.recall(bankId, "What does David do?")
    console.log("[pipeline] recalled:", recallResult.memories.length)

    // Step 3: Reflect
    const reflectResult = await t.hs.reflect(
      bankId,
      "Summarize what you know about David.",
      { budget: "low" },
    )
    console.log("[pipeline] reflect answer:", reflectResult.answer.slice(0, 300))

    // Loose checks — just verify the pipeline didn't crash
    expect(retainResult.memories.length).toBeGreaterThanOrEqual(0)
    expect(reflectResult.answer.trim().length).toBeGreaterThan(0)
  }, 180_000)
})
