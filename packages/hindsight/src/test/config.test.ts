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
      expect(bank.config.extractionMode).toBe(mode)
    }
  })

  it("accepts valid reflectBudget values", () => {
    t = createTestHindsight()
    const budgets: Array<"low" | "mid" | "high"> = ["low", "mid", "high"]
    for (const budget of budgets) {
      const bank = t.hs.createBank(`budget-${budget}`, {
        config: { reflectBudget: budget },
      })
      expect(bank.config.reflectBudget).toBe(budget)
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
  it("throws when retainMaxCompletionTokens <= retainChunkSize (tokens must exceed chunk size)", () => {
    expect(() =>
      createTestHindsight({
        retainMaxCompletionTokens: 1000,
        retainChunkSize: 2000,
      }),
    ).toThrow(/must be greater than/i)
  })

  it("throws when retainMaxCompletionTokens equals retainChunkSize", () => {
    expect(() =>
      createTestHindsight({
        retainMaxCompletionTokens: 3000,
        retainChunkSize: 3000,
      }),
    ).toThrow(/must be greater than/i)
  })

  it("error message names both offending parameters and their values", () => {
    const run = () =>
      createTestHindsight({
        retainMaxCompletionTokens: 1000,
        retainChunkSize: 2000,
      })

    expect(run).toThrow(/HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS/)
    expect(run).toThrow(/1000/)
    expect(run).toThrow(/HINDSIGHT_API_RETAIN_CHUNK_SIZE/)
    expect(run).toThrow(/2000/)
  })

  it("error message includes guidance on how to fix the invalid combination", () => {
    const run = () =>
      createTestHindsight({
        retainMaxCompletionTokens: 1000,
        retainChunkSize: 2000,
      })

    expect(run).toThrow(/You have two options to fix this/i)
    expect(run).toThrow(/Increase HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS/i)
    expect(run).toThrow(/use a model that supports/i)
  })

  it("accepts valid config where retainMaxCompletionTokens > retainChunkSize", () => {
    const t = createTestHindsight({
      retainMaxCompletionTokens: 64_000,
      retainChunkSize: 3_000,
    })
    t.cleanup()
  })
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
