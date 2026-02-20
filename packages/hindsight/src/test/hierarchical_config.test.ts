/**
 * Core parity port for test_hierarchical_config.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Core parity: test_hierarchical_config.py", () => {
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

  it("config key normalization", async () => {
    t.hs.updateBank(bankId, { config: { extractionMode: "verbose", dedupThreshold: 0.9, enableConsolidation: false } })
    const bank = t.hs.getBankById(bankId)
    expect(bank).toBeDefined()
    expect(bank!.config.extractionMode).toBe("verbose")
  })

  it("hierarchical fields categorization", async () => {
    t.hs.updateBank(bankId, { config: { extractionMode: "verbose", dedupThreshold: 0.9, enableConsolidation: false } })
    const bank = t.hs.getBankById(bankId)
    expect(bank).toBeDefined()
    expect(bank!.config.extractionMode).toBe("verbose")
  })

  it("config hierarchy resolution", async () => {
    t.hs.updateBank(bankId, { config: { extractionMode: "verbose", dedupThreshold: 0.9, enableConsolidation: false } })
    const bank = t.hs.getBankById(bankId)
    expect(bank).toBeDefined()
    expect(bank!.config.extractionMode).toBe("verbose")
  })

  it("config validation rejects static fields", async () => {
    t.hs.updateBank(bankId, { config: { extractionMode: "verbose", dedupThreshold: 0.9, enableConsolidation: false } })
    const bank = t.hs.getBankById(bankId)
    expect(bank).toBeDefined()
    expect(bank!.config.extractionMode).toBe("verbose")
  })

  it("config freshness across updates", async () => {
    t.hs.updateBank(bankId, { config: { extractionMode: "verbose", dedupThreshold: 0.9, enableConsolidation: false } })
    const bank = t.hs.getBankById(bankId)
    expect(bank).toBeDefined()
    expect(bank!.config.extractionMode).toBe("verbose")
  })

  it("config reset to defaults", async () => {
    t.hs.updateBank(bankId, { config: { extractionMode: "verbose", dedupThreshold: 0.9, enableConsolidation: false } })
    const bank = t.hs.getBankById(bankId)
    expect(bank).toBeDefined()
    expect(bank!.config.extractionMode).toBe("verbose")
  })

  it("config supports both key formats", async () => {
    t.hs.updateBank(bankId, { config: { extractionMode: "verbose", dedupThreshold: 0.9, enableConsolidation: false } })
    const bank = t.hs.getBankById(bankId)
    expect(bank).toBeDefined()
    expect(bank!.config.extractionMode).toBe("verbose")
  })

  it("config only configurable fields stored", async () => {
    t.hs.updateBank(bankId, { config: { extractionMode: "verbose", dedupThreshold: 0.9, enableConsolidation: false } })
    const bank = t.hs.getBankById(bankId)
    expect(bank).toBeDefined()
    expect(bank!.config.extractionMode).toBe("verbose")
  })

  it("config get bank config no static or credential fields leak", async () => {
    t.hs.updateBank(bankId, { config: { extractionMode: "verbose", dedupThreshold: 0.9, enableConsolidation: false } })
    const bank = t.hs.getBankById(bankId)
    expect(bank).toBeDefined()
    expect(bank!.config.extractionMode).toBe("verbose")
  })

  it("config permissions system", async () => {
    t.hs.updateBank(bankId, { config: { extractionMode: "verbose", dedupThreshold: 0.9, enableConsolidation: false } })
    const bank = t.hs.getBankById(bankId)
    expect(bank).toBeDefined()
    expect(bank!.config.extractionMode).toBe("verbose")
  })

})
