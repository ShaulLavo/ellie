/**
 * Tests for temporal.ts — temporal range extraction from queries.
 *
 * Port of test_query_analyzer.py + test_link_utils.py.
 * Pure unit tests — no DB or LLM needed.
 */

import { describe, it, expect } from "bun:test"
import { extractTemporalRange } from "../temporal"

// Use a fixed reference date for deterministic tests
// 2024-06-15 12:00:00 UTC (Saturday)
const REFERENCE = new Date("2024-06-15T12:00:00.000Z")

function startOfDay(date: Date): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function endOfDay(date: Date): number {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

function daysFromRef(days: number): Date {
  const d = new Date(REFERENCE)
  d.setDate(d.getDate() + days)
  return d
}

// ════════════════════════════════════════════════════════════════════════════
// extractTemporalRange
// ════════════════════════════════════════════════════════════════════════════

describe("extractTemporalRange", () => {
  describe("returns undefined for non-temporal queries", () => {
    it("plain question", () => {
      expect(extractTemporalRange("What are Peter's hobbies?", REFERENCE)).toBeUndefined()
    })

    it("no temporal keywords", () => {
      expect(extractTemporalRange("Tell me about dogs", REFERENCE)).toBeUndefined()
    })

    it("empty query", () => {
      expect(extractTemporalRange("", REFERENCE)).toBeUndefined()
    })
  })

  describe("yesterday", () => {
    it("detects 'yesterday'", () => {
      const range = extractTemporalRange("What happened yesterday?", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(-1)))
      expect(range!.to).toBe(endOfDay(daysFromRef(-1)))
    })
  })

  describe("today", () => {
    it("detects 'today'", () => {
      const range = extractTemporalRange("What did I do today?", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(REFERENCE))
      expect(range!.to).toBe(endOfDay(REFERENCE))
    })
  })

  describe("tomorrow", () => {
    it("detects 'tomorrow'", () => {
      const range = extractTemporalRange("What is planned for tomorrow?", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(1)))
      expect(range!.to).toBe(endOfDay(daysFromRef(1)))
    })
  })

  describe("last night", () => {
    it("detects 'last night'", () => {
      const range = extractTemporalRange("What happened last night?", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(-1)))
      expect(range!.to).toBe(endOfDay(daysFromRef(-1)))
    })
  })

  describe("last week", () => {
    it("detects 'last week'", () => {
      const range = extractTemporalRange("What happened last week?", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(-7)))
      expect(range!.to).toBe(endOfDay(daysFromRef(-1)))
    })
  })

  describe("this week", () => {
    it("detects 'this week'", () => {
      const range = extractTemporalRange("What's on this week?", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(-3)))
      expect(range!.to).toBe(endOfDay(daysFromRef(3)))
    })
  })

  describe("last month", () => {
    it("detects 'last month'", () => {
      const range = extractTemporalRange("What happened last month?", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(-30)))
      expect(range!.to).toBe(endOfDay(daysFromRef(-1)))
    })
  })

  describe("last N days", () => {
    it("detects 'last 30 days'", () => {
      const range = extractTemporalRange("What happened in the last 30 days?", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(-30)))
      expect(range!.to).toBe(endOfDay(REFERENCE))
    })

    it("detects 'last 7 days'", () => {
      const range = extractTemporalRange("Show me last 7 days", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(-7)))
      expect(range!.to).toBe(endOfDay(REFERENCE))
    })

    it("detects 'last 1 day'", () => {
      const range = extractTemporalRange("in the last 1 day", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(-1)))
      expect(range!.to).toBe(endOfDay(REFERENCE))
    })
  })

  describe("last N weeks", () => {
    it("detects 'last 2 weeks'", () => {
      const range = extractTemporalRange("What changed last 2 weeks?", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(-14)))
      expect(range!.to).toBe(endOfDay(REFERENCE))
    })
  })

  describe("last N months", () => {
    it("detects 'last 3 months'", () => {
      const range = extractTemporalRange("Summary of last 3 months", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(-90)))
      expect(range!.to).toBe(endOfDay(REFERENCE))
    })
  })

  describe("this morning", () => {
    it("detects 'this morning'", () => {
      const range = extractTemporalRange("What did we discuss this morning?", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(REFERENCE))
      expect(range!.to).toBe(endOfDay(REFERENCE))
    })
  })

  describe("next week / next month", () => {
    it("detects 'next week'", () => {
      const range = extractTemporalRange("What's planned next week?", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(1)))
      expect(range!.to).toBe(endOfDay(daysFromRef(7)))
    })

    it("detects 'next month'", () => {
      const range = extractTemporalRange("Events next month", REFERENCE)
      expect(range).toBeDefined()
      expect(range!.from).toBe(startOfDay(daysFromRef(1)))
      expect(range!.to).toBe(endOfDay(daysFromRef(30)))
    })
  })

  // TDD targets from Python test_query_analyzer.py — these test more
  // colloquial expressions not yet supported by temporal.ts

  describe("TDD targets: colloquial expressions", () => {
    it.todo("detects 'june 2024' → month range")
    it.todo("detects 'last year' → full previous year")
    it.todo("detects 'last Saturday' → specific day")
    it.todo("detects specific month/year like 'dogs in June 2023'")
    it.todo("detects 'a couple of days ago'")
  })

  // ── Missing Python tests (test_query_analyzer.py) ──────────────────────
  // These are specific test cases from the Python suite that are not yet
  // represented above, added as .todo() items for future implementation.

  describe("TDD targets: named month+year parsing", () => {
    it.todo("detects 'March 2023' → 2023-03-01 to 2023-03-31")
    it.todo("detects 'melanie activities in june 2024' → 2024-06-01 to 2024-06-30")
  })

  describe("TDD targets: named day of week", () => {
    it.todo("detects 'last Saturday' → resolves to the most recent Saturday")
    it.todo("detects 'last Friday' → resolves to the most recent Friday")
    it.todo("detects 'last weekend' → resolves to the most recent Sat-Sun range")
  })

  describe("TDD targets: fuzzy temporal phrases", () => {
    it.todo("detects 'a couple of days ago' → 1-3 days ago range")
    it.todo("detects 'a few days ago' → 2-5 days ago range")
    it.todo("detects 'a couple of weeks ago' → 1-3 weeks ago range")
  })

  describe("TDD targets: last year", () => {
    it.todo("detects 'last year' → full previous calendar year (Jan 1 to Dec 31)")
  })
})

// ── Temporal fields written to DB (port of test_temporal_ranges.py) ────────

describe("temporal fields written to DB", () => {
  it.todo("occurred_start, occurred_end, and mentioned_at are written to the database after retain")
  it.todo("mentioned_at is close to the event_date provided at retain time")
  it.todo("point event: occurred_start and occurred_end are within the same day")
  it.todo("period event: occurred_start is in the correct month/year (e.g. February 2024)")
  it.todo("temporal fields are present and populated in search/recall results")
})
