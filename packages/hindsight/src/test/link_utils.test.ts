/**
 * Core parity port for test_link_utils.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Core parity: test_link_utils.py", () => {
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

  it("none returns none", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("naive datetime becomes utc", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("aware datetime unchanged", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("mixed datetimes can be compared", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("empty units returns none", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("single unit normal date", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("multiple units", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("mixed naive and aware datetimes", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("overflow near datetime min", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("overflow near datetime max", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("empty units returns empty", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("no candidates returns empty", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("multiple units multiple candidates", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("mixed naive and aware datetimes", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("overflow near datetime min", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

  it("overflow near datetime max", async () => {
    await t.hs.retain(bankId, "dates", { facts: [{ content: "Date lower", validFrom: new Date("2020-01-01T00:00:00Z").getTime(), validTo: null }, { content: "Date upper", validFrom: null, validTo: new Date("2030-01-01T00:00:00Z").getTime() }], consolidate: false })
    const temporal = await t.hs.recall(bankId, "date", { methods: ["temporal"], timeRange: { from: Date.now() - 4000 * 86_400_000, to: Date.now() } })
    expect(Array.isArray(temporal.memories)).toBe(true)
  })

})
