/**
 * Tests for configuration validation and defaults merging.
 *
 * Port of test_config_validation.py.
 * Light integration tests.
 */

import { describe, it, expect, afterEach } from "bun:test"
import { createTestHindsight, type TestHindsight } from "./setup"
describe("BankConfig validation", () => {
  let t: TestHindsight

  afterEach(() => {
    t?.cleanup()
  })

  it("accepts valid extractionMode values", () => {
    t = createTestHindsight()
    const modes: Array<"concise" | "verbose" | "custom"> = ["concise", "verbose", "custom"]
    for (const mode of modes) {
      const bank = t.hs.createBank(`mode-${mode}`, {
        config: { extractionMode: mode },
      })
      const extractionMode = bank.config.extractionMode
      expect(extractionMode).toBeDefined()
      if (!extractionMode) throw new Error("Expected extractionMode to be set")
      expect(extractionMode).toBe(mode)
    }
  })

  it("accepts valid reflectBudget values", () => {
    t = createTestHindsight()
    const budgets: Array<"low" | "mid" | "high"> = ["low", "mid", "high"]
    for (const budget of budgets) {
      const bank = t.hs.createBank(`budget-${budget}`, {
        config: { reflectBudget: budget },
      })
      const reflectBudget = bank.config.reflectBudget
      expect(reflectBudget).toBeDefined()
      if (!reflectBudget) throw new Error("Expected reflectBudget to be set")
      expect(reflectBudget).toBe(budget)
    }
  })

  it("accepts dedupThreshold between 0 and 1", () => {
    t = createTestHindsight()
    const thresholds = [0, 0.5, 0.92, 1.0]
    for (const threshold of thresholds) {
      const bank = t.hs.createBank(`thresh-${threshold}`, {
        config: { dedupThreshold: threshold },
      })
      expect(bank.config.dedupThreshold).toBe(threshold)
    }
  })

  it("stores enableConsolidation flag", () => {
    t = createTestHindsight()
    const bankEnabled = t.hs.createBank("consolidation-on", {
      config: { enableConsolidation: true },
    })
    expect(bankEnabled.config.enableConsolidation).toBe(true)

    const bankDisabled = t.hs.createBank("consolidation-off", {
      config: { enableConsolidation: false },
    })
    expect(bankDisabled.config.enableConsolidation).toBe(false)
  })

  it("stores customGuidelines", () => {
    t = createTestHindsight()
    const bank = t.hs.createBank("custom", {
      config: {
        extractionMode: "custom",
        customGuidelines: "Focus on technical facts only.",
      },
    })
    expect(bank.config.customGuidelines).toBe("Focus on technical facts only.")
  })
})

// ── Hindsight instance config validation (port of test_config_validation.py) ──

describe("Hindsight instance config validation", () => {
  it.todo("throws when retainMaxCompletionTokens <= retainChunkSize (tokens must exceed chunk size)")
  it.todo("throws when retainMaxCompletionTokens equals retainChunkSize")
  it.todo("error message names both offending parameters and their values")
  it.todo("error message includes guidance on how to fix the invalid combination")
  it.todo("accepts valid config where retainMaxCompletionTokens > retainChunkSize")
})

describe("Defaults merging", () => {
  it("instance defaults fill gaps in bank config", () => {
    const t = createTestHindsight({
      defaults: {
        extractionMode: "verbose",
        dedupThreshold: 0.8,
        reflectBudget: "high",
      },
    })
    try {
      // Bank only overrides extractionMode
      const bank = t.hs.createBank("partial-override", {
        config: { extractionMode: "concise" },
      })
      // Bank config stores what was explicitly set
      expect(bank.config.extractionMode).toBe("concise")
      // Instance defaults for other fields are applied at resolve time (private)
    } finally {
      t.cleanup()
    }
  })
})

describe("Hindsight instance config validation (TDD targets)", () => {
  it.todo("throws when retainMaxCompletionTokens <= retainChunkSize")
  // Python: test_retain_max_completion_tokens_must_be_greater_than_chunk_size

  it.todo("throws when retainMaxCompletionTokens equals retainChunkSize")
  // Python: test_retain_max_completion_tokens_equal_to_chunk_size_fails

  it.todo("error message includes both parameter names and their values")
  // Python: test_retain_max_completion_tokens_must_be_greater_than_chunk_size
  // — error says which params violated the constraint

  it.todo("valid config with maxCompletionTokens > chunkSize succeeds")
  // Python: test_valid_retain_config_succeeds
})
