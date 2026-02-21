/**
 * Tests for temporal extraction + temporal link/field behavior.
 *
 * Parity targets:
 * - test_query_analyzer.py
 * - test_link_utils.py (behavior-level via retain pipeline)
 * - test_temporal_ranges.py (deterministic field persistence checks)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { extractTemporalRange } from "../temporal"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"
import type { HindsightDatabase } from "../db"

const REFERENCE = new Date("2025-01-15T12:00:00.000Z") // Wednesday

function startOfDay(date: Date): number {
  const value = new Date(date)
  value.setHours(0, 0, 0, 0)
  return value.getTime()
}

function endOfDay(date: Date): number {
  const value = new Date(date)
  value.setHours(23, 59, 59, 999)
  return value.getTime()
}

function dayFromReference(dayOffset: number): Date {
  const value = new Date(REFERENCE)
  value.setDate(value.getDate() + dayOffset)
  return value
}

function expectRange(
  range: { from: number; to: number } | undefined,
  from: Date,
  to: Date = from,
): void {
  expect(range).toBeDefined()
  expect(range!.from).toBe(startOfDay(from))
  expect(range!.to).toBe(endOfDay(to))
}

describe("extractTemporalRange", () => {
  it("returns undefined for non-temporal queries", () => {
    expect(extractTemporalRange("What are Peter's hobbies?", REFERENCE)).toBeUndefined()
    expect(extractTemporalRange("Tell me about dogs", REFERENCE)).toBeUndefined()
    expect(extractTemporalRange("", REFERENCE)).toBeUndefined()
  })

  it("detects 'june 2024' → month range", () => {
    const range = extractTemporalRange("june 2024", REFERENCE)
    expectRange(range, new Date("2024-06-01T00:00:00.000Z"), new Date("2024-06-30T00:00:00.000Z"))
  })

  it("detects specific month/year phrase like 'dogs in June 2023'", () => {
    const range = extractTemporalRange("dogs in June 2023", REFERENCE)
    expectRange(range, new Date("2023-06-01T00:00:00.000Z"), new Date("2023-06-30T00:00:00.000Z"))
  })

  it("detects 'March 2023' → 2023-03-01 to 2023-03-31", () => {
    const range = extractTemporalRange("March 2023", REFERENCE)
    expectRange(range, new Date("2023-03-01T00:00:00.000Z"), new Date("2023-03-31T00:00:00.000Z"))
  })

  it("detects 'melanie activities in june 2024' → 2024-06-01 to 2024-06-30", () => {
    const range = extractTemporalRange("melanie activities in june 2024", REFERENCE)
    expectRange(range, new Date("2024-06-01T00:00:00.000Z"), new Date("2024-06-30T00:00:00.000Z"))
  })

  it("detects 'last year' → full previous year", () => {
    const range = extractTemporalRange("last year", REFERENCE)
    expectRange(range, new Date("2024-01-01T00:00:00.000Z"), new Date("2024-12-31T00:00:00.000Z"))
  })

  it("detects 'last Saturday' → specific day", () => {
    const range = extractTemporalRange("I received jewelry last Saturday", REFERENCE)
    expectRange(range, new Date("2025-01-11T00:00:00.000Z"))
  })

  it("detects 'last Friday' → specific day", () => {
    const range = extractTemporalRange("who did I meet last Friday?", REFERENCE)
    expectRange(range, new Date("2025-01-10T00:00:00.000Z"))
  })

  it("detects 'last weekend' → Sat-Sun range", () => {
    const range = extractTemporalRange("what did I do last weekend?", REFERENCE)
    expectRange(
      range,
      new Date("2025-01-11T00:00:00.000Z"),
      new Date("2025-01-12T00:00:00.000Z"),
    )
  })

  it("detects 'a couple of days ago' → 1-3 days ago range", () => {
    const range = extractTemporalRange("a couple of days ago we discussed this", REFERENCE)
    expectRange(range, dayFromReference(-3), dayFromReference(-1))
  })

  it("detects 'a few days ago' → 2-5 days ago range", () => {
    const range = extractTemporalRange("what did I do a few days ago", REFERENCE)
    expectRange(range, dayFromReference(-5), dayFromReference(-2))
  })

  it("detects 'a couple of weeks ago' → 1-3 weeks ago range", () => {
    const range = extractTemporalRange("a couple of weeks ago we discussed this", REFERENCE)
    expectRange(range, dayFromReference(-21), dayFromReference(-7))
  })
})

describe("temporal link behavior via retain pipeline", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  function getTemporalLinks(sourceId: string, targetId?: string): Array<{ source_id: string; target_id: string; weight: number }> {
    const hdb = (t.hs as unknown as { hdb: HindsightDatabase }).hdb
    if (targetId) {
      return hdb.sqlite
        .prepare(
          `SELECT source_id, target_id, weight
           FROM hs_memory_links
           WHERE link_type = 'temporal'
             AND source_id = ?
             AND target_id = ?`,
        )
        .all(sourceId, targetId) as Array<{ source_id: string; target_id: string; weight: number }>
    }

    return hdb.sqlite
      .prepare(
        `SELECT source_id, target_id, weight
         FROM hs_memory_links
         WHERE link_type = 'temporal'
           AND source_id = ?`,
      )
      .all(sourceId) as Array<{ source_id: string; target_id: string; weight: number }>
  }

  it("candidate within temporal window creates a link", async () => {
    const base = Date.parse("2024-06-15T12:00:00.000Z")

    const first = await t.hs.retain(bankId, "first", {
      facts: [{ content: "Candidate memory", occurredStart: base - 2 * 60 * 60 * 1000 }],
      eventDate: base - 2 * 60 * 60 * 1000,
      dedupThreshold: 0,
      consolidate: false,
    })

    const second = await t.hs.retain(bankId, "second", {
      facts: [{ content: "Source memory", occurredStart: base }],
      eventDate: base,
      dedupThreshold: 0,
      consolidate: false,
    })

    const links = getTemporalLinks(second.memories[0]!.id, first.memories[0]!.id)
    expect(links.length).toBeGreaterThan(0)
    expect(links[0]!.weight).toBeGreaterThan(0.9)
  })

  it("candidate outside temporal window creates no link", async () => {
    const base = Date.parse("2024-06-15T12:00:00.000Z")

    const first = await t.hs.retain(bankId, "first", {
      facts: [{ content: "Old memory", occurredStart: base - 3 * 24 * 60 * 60 * 1000 }],
      eventDate: base - 3 * 24 * 60 * 60 * 1000,
      dedupThreshold: 0,
      consolidate: false,
    })

    const second = await t.hs.retain(bankId, "second", {
      facts: [{ content: "New memory", occurredStart: base }],
      eventDate: base,
      dedupThreshold: 0,
      consolidate: false,
    })

    const links = getTemporalLinks(second.memories[0]!.id, first.memories[0]!.id)
    expect(links).toHaveLength(0)
  })

  it("link weight decreases with temporal distance", async () => {
    const base = Date.parse("2024-06-15T12:00:00.000Z")

    const close = await t.hs.retain(bankId, "close", {
      facts: [{ content: "Close candidate", occurredStart: base - 1 * 60 * 60 * 1000 }],
      eventDate: base - 1 * 60 * 60 * 1000,
      dedupThreshold: 0,
      consolidate: false,
    })

    const far = await t.hs.retain(bankId, "far", {
      facts: [{ content: "Far candidate", occurredStart: base - 18 * 60 * 60 * 1000 }],
      eventDate: base - 18 * 60 * 60 * 1000,
      dedupThreshold: 0,
      consolidate: false,
    })

    const source = await t.hs.retain(bankId, "source", {
      facts: [{ content: "Source memory", occurredStart: base }],
      eventDate: base,
      dedupThreshold: 0,
      consolidate: false,
    })

    const toClose = getTemporalLinks(source.memories[0]!.id, close.memories[0]!.id)[0]
    const toFar = getTemporalLinks(source.memories[0]!.id, far.memories[0]!.id)[0]
    expect(toClose).toBeDefined()
    expect(toFar).toBeDefined()
    expect(toClose!.weight).toBeGreaterThan(toFar!.weight)
  })

  it("minimum link weight is 0.3", async () => {
    const base = Date.parse("2024-06-15T12:00:00.000Z")

    const edge = await t.hs.retain(bankId, "edge", {
      facts: [{ content: "Edge candidate", occurredStart: base - 23 * 60 * 60 * 1000 }],
      eventDate: base - 23 * 60 * 60 * 1000,
      dedupThreshold: 0,
      consolidate: false,
    })

    const source = await t.hs.retain(bankId, "source", {
      facts: [{ content: "Source memory", occurredStart: base }],
      eventDate: base,
      dedupThreshold: 0,
      consolidate: false,
    })

    const link = getTemporalLinks(source.memories[0]!.id, edge.memories[0]!.id)[0]
    expect(link).toBeDefined()
    expect(link!.weight).toBeGreaterThanOrEqual(0.3)
  })

  it("maximum 10 temporal links per memory unit", async () => {
    const base = Date.parse("2024-06-15T12:00:00.000Z")

    for (let i = 0; i < 15; i++) {
      await t.hs.retain(bankId, `candidate-${i}`, {
        facts: [{ content: `Candidate ${i}`, occurredStart: base - i * 60 * 1000 }],
        eventDate: base - i * 60 * 1000,
        dedupThreshold: 0,
        consolidate: false,
      })
    }

    const source = await t.hs.retain(bankId, "source", {
      facts: [{ content: "Source memory", occurredStart: base }],
      eventDate: base,
      dedupThreshold: 0,
      consolidate: false,
    })

    const links = getTemporalLinks(source.memories[0]!.id)
    expect(links.length).toBeLessThanOrEqual(10)
    expect(links.length).toBe(10)
  })
})

describe("temporal fields written to DB", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  it("occurred_start, occurred_end, and mentioned_at are written after retain", async () => {
    const eventDate = Date.parse("2024-11-17T10:00:00.000Z")
    const pointStart = Date.parse("2024-11-16T08:00:00.000Z")
    const pointEnd = Date.parse("2024-11-16T18:00:00.000Z")
    const periodStart = Date.parse("2024-02-01T00:00:00.000Z")
    const periodEnd = Date.parse("2024-02-29T23:59:59.000Z")

    const retain = await t.hs.retain(bankId, "temporal fields", {
      eventDate,
      facts: [
        { content: "Pottery workshop yesterday", occurredStart: pointStart, occurredEnd: pointEnd },
        { content: "Alice visited Paris in February 2024", occurredStart: periodStart, occurredEnd: periodEnd },
      ],
      dedupThreshold: 0,
      consolidate: false,
    })

    expect(retain.memories.length).toBeGreaterThanOrEqual(2)
    for (const memory of retain.memories) {
      expect(memory.eventDate).not.toBeNull()
      expect(memory.occurredStart).not.toBeNull()
      expect(memory.occurredEnd).not.toBeNull()
      expect(memory.occurredStart).not.toBeNull()
      expect(memory.occurredEnd).not.toBeNull()
      expect(memory.mentionedAt).not.toBeNull()
    }

    const listed = t.hs.listMemoryUnits(bankId)
    expect(listed.items.length).toBeGreaterThanOrEqual(2)
    for (const item of listed.items) {
      expect(item.occurredStart).not.toBeNull()
      expect(item.occurredEnd).not.toBeNull()
      expect(item.mentionedAt).not.toBeNull()
    }
  })

  it("mentioned_at is close to the event_date provided at retain time", async () => {
    const eventDate = Date.parse("2024-11-17T10:00:00.000Z")

    const result = await t.hs.retain(bankId, "single fact", {
      eventDate,
      facts: [{ content: "Single timestamped fact" }],
      dedupThreshold: 0,
      consolidate: false,
    })

    const mentionedAt = result.memories[0]!.mentionedAt
    expect(mentionedAt).not.toBeNull()
    expect(Math.abs(mentionedAt! - eventDate)).toBeLessThanOrEqual(1000)
  })

  it("point event: occurred_start and occurred_end are within the same day", async () => {
    const occurredStart = Date.parse("2024-11-16T08:00:00.000Z")
    const occurredEnd = Date.parse("2024-11-16T18:00:00.000Z")

    const result = await t.hs.retain(bankId, "point event", {
      facts: [{ content: "Point event", occurredStart, occurredEnd }],
      dedupThreshold: 0,
      consolidate: false,
    })

    const memory = result.memories[0]!
    expect(memory.occurredStart).not.toBeNull()
    expect(memory.occurredEnd).not.toBeNull()
    expect(memory.occurredStart).not.toBeNull()
    expect(memory.occurredEnd).not.toBeNull()
    const sameDay =
      new Date(memory.occurredStart!).toISOString().slice(0, 10) ===
      new Date(memory.occurredEnd!).toISOString().slice(0, 10)
    expect(sameDay).toBe(true)
  })

  it("period event: occurred_start is in the correct month/year (e.g. February 2024)", async () => {
    const occurredStart = Date.parse("2024-02-01T00:00:00.000Z")
    const occurredEnd = Date.parse("2024-02-29T23:59:59.000Z")

    const result = await t.hs.retain(bankId, "period event", {
      facts: [{ content: "February period event", occurredStart, occurredEnd }],
      dedupThreshold: 0,
      consolidate: false,
    })

    const memory = result.memories[0]!
    const start = new Date(memory.occurredStart!)
    expect(start.getUTCFullYear()).toBe(2024)
    expect(start.getUTCMonth()).toBe(1)
  })

  it("temporal fields are present and populated in search/recall results", async () => {
    const occurredStart = Date.parse("2024-11-16T08:00:00.000Z")
    const occurredEnd = Date.parse("2024-11-16T18:00:00.000Z")

    await t.hs.retain(bankId, "searchable temporal", {
      facts: [{ content: "Pottery workshop detail", occurredStart, occurredEnd }],
      dedupThreshold: 0,
      consolidate: false,
    })

    const result = await t.hs.recall(bankId, "pottery workshop", {
      factTypes: ["experience", "world"],
      limit: 5,
    })

    expect(result.memories.length).toBeGreaterThan(0)
    const first = result.memories[0]!.memory
    expect(first.eventDate).not.toBeNull()
    expect(first.occurredStart).not.toBeNull()
    expect(first.occurredEnd).not.toBeNull()
    expect(first.occurredStart).not.toBeNull()
    expect(first.occurredEnd).not.toBeNull()
    expect(first.mentionedAt).not.toBeNull()
  })
})
