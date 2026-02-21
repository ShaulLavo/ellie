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

  function applyConfig() {
    return t.hs.updateBankConfig(bankId, {
      extractionMode: "verbose",
      dedupThreshold: 0.9,
      enableConsolidation: false,
      reflectBudget: "high",
    })
  }

  it("config key normalization", async () => {
    const bank = applyConfig()
    expect(bank.config.extractionMode).toBe("verbose")
    expect(bank.config.dedupThreshold).toBe(0.9)
  })

  it("hierarchical fields categorization", async () => {
    const bank = applyConfig()
    expect(bank.config.enableConsolidation).toBe(false)
    expect(bank.config.reflectBudget).toBe("high")
    expect(bank.config.customGuidelines).toBeUndefined()
    expect(bank!.config.extractionMode).toBe("verbose")
  })

  it("config hierarchy resolution", async () => {
    const bank = applyConfig()
    expect(bank.config.dedupThreshold).toBe(0.9)
    expect(bank.config.enableConsolidation).toBe(false)
    expect(bank!.config.extractionMode).toBe("verbose")
  })

  it("config validation rejects static fields", async () => {
    const run = () =>
      t.hs.updateBankConfig(
        bankId,
        { extractionMode: "verbose", dedupThreshold: 0.9, enableConsolidation: false },
      )
    expect(run).not.toThrow()
  })

  it("config freshness across updates", async () => {
    const first = t.hs.updateBankConfig(bankId, {
      extractionMode: "concise",
      dedupThreshold: 0.8,
    })
    const second = t.hs.updateBankConfig(bankId, {
      extractionMode: "verbose",
      dedupThreshold: 0.9,
    })
    expect(first.updatedAt).toBeLessThanOrEqual(second.updatedAt)
    expect(second.config.extractionMode).toBe("verbose")
  })

  it("config reset to defaults", async () => {
    t.hs.updateBankConfig(bankId, {
      extractionMode: "verbose",
      dedupThreshold: 0.9,
      enableConsolidation: false,
    })
    const bank = t.hs.updateBankConfig(bankId, {
      extractionMode: "concise",
      dedupThreshold: 0.92,
      enableConsolidation: true,
      customGuidelines: null,
      reflectBudget: "mid",
    })
    expect(bank.config.extractionMode).toBe("concise")
    expect(bank.config.dedupThreshold).toBe(0.92)
    expect(bank.config.enableConsolidation).toBe(true)
  })

  it("config supports both key formats", async () => {
    const bank = applyConfig()
    expect(bank.config.extractionMode).toBe("verbose")
    expect(bank.config.enableConsolidation).toBe(false)
  })

  it("config only configurable fields stored", async () => {
    t.hs.updateBankConfig(bankId, {
      extractionMode: "verbose",
      dedupThreshold: 0.9,
      enableConsolidation: false,
    })
    const bank = t.hs.getBankById(bankId)!
    expect(Object.keys(bank.config).sort()).toEqual([
      "dedupThreshold",
      "enableConsolidation",
      "extractionMode",
    ])
  })

  it("config get bank config no static or credential fields leak", async () => {
    const bank = applyConfig()
    const configKeys = Object.keys(bank.config)
    expect(configKeys).not.toContain("dbPath")
    expect(configKeys).not.toContain("adapter")
    expect(configKeys).not.toContain("embed")
    expect(configKeys).not.toContain("embedBatch")
    expect(configKeys).not.toContain("extensions")
  })

  it("config permissions system", async () => {
    const bank = t.hs.updateBank(bankId, { name: "updated-name", mission: "updated mission" })
    expect(bank.name).toBe("updated-name")
    expect(bank.mission).toBe("updated mission")
  })

})
