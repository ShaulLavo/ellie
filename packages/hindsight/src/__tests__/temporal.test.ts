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

  describe("TDD targets: colloquial expressions", () => {
    it("detects 'june 2024' → month range", () => {
      throw new Error("implement me: extractTemporalRange needs named month+year parsing — see test_query_analyzer.py::test_june_2024")
    })
    it("detects 'last year' → full previous year", () => {
      throw new Error("implement me: extractTemporalRange needs 'last year' support — see test_query_analyzer.py::test_last_year")
    })
    it("detects 'last Saturday' → specific day", () => {
      throw new Error("implement me: extractTemporalRange needs named day-of-week parsing — see test_query_analyzer.py::test_last_saturday")
    })
    it("detects specific month/year like 'dogs in June 2023'", () => {
      throw new Error("implement me: extractTemporalRange needs named month+year parsing — see test_query_analyzer.py::test_dogs_in_june_2023")
    })
    it("detects 'a couple of days ago'", () => {
      throw new Error("implement me: extractTemporalRange needs fuzzy temporal phrase parsing — see test_query_analyzer.py::test_couple_of_days_ago")
    })
  })

  describe("TDD targets: named month+year parsing", () => {
    it("detects 'March 2023' → 2023-03-01 to 2023-03-31", () => {
      throw new Error("implement me: extractTemporalRange needs named month+year parsing — see test_query_analyzer.py::test_march_2023")
    })
    it("detects 'melanie activities in june 2024' → 2024-06-01 to 2024-06-30", () => {
      throw new Error("implement me: extractTemporalRange needs named month+year parsing — see test_query_analyzer.py::test_melanie_june_2024")
    })
  })

  describe("TDD targets: named day of week", () => {
    it("detects 'last Saturday' → resolves to the most recent Saturday", () => {
      throw new Error("implement me: extractTemporalRange needs named day-of-week parsing — see test_query_analyzer.py::test_last_saturday")
    })
    it("detects 'last Friday' → resolves to the most recent Friday", () => {
      throw new Error("implement me: extractTemporalRange needs named day-of-week parsing — see test_query_analyzer.py::test_last_friday")
    })
    it("detects 'last weekend' → resolves to the most recent Sat-Sun range", () => {
      throw new Error("implement me: extractTemporalRange needs 'last weekend' support — see test_query_analyzer.py::test_last_weekend")
    })
  })

  describe("TDD targets: fuzzy temporal phrases", () => {
    it("detects 'a couple of days ago' → 1-3 days ago range", () => {
      throw new Error("implement me: extractTemporalRange needs fuzzy temporal phrase parsing — see test_query_analyzer.py::test_couple_of_days_ago")
    })
    it("detects 'a few days ago' → 2-5 days ago range", () => {
      throw new Error("implement me: extractTemporalRange needs fuzzy temporal phrase parsing — see test_query_analyzer.py::test_few_days_ago")
    })
    it("detects 'a couple of weeks ago' → 1-3 weeks ago range", () => {
      throw new Error("implement me: extractTemporalRange needs fuzzy temporal phrase parsing — see test_query_analyzer.py::test_couple_of_weeks_ago")
    })
  })

  describe("TDD targets: last year", () => {
    it("detects 'last year' → full previous calendar year (Jan 1 to Dec 31)", () => {
      throw new Error("implement me: extractTemporalRange needs 'last year' → full calendar year — see test_query_analyzer.py::test_last_year_full_range")
    })
  })
})

describe("compute_temporal_links (TDD targets)", () => {
  it("candidate within temporal window creates a link", () => {
    throw new Error("implement me: computeTemporalLinks not exposed as standalone function — see test_link_utils.py::test_candidate_within_window_creates_link")
  })
  it("candidate outside temporal window creates no link", () => {
    throw new Error("implement me: computeTemporalLinks not exposed as standalone function — see test_link_utils.py::test_candidate_outside_window_no_link")
  })
  it("link weight decreases with temporal distance", () => {
    throw new Error("implement me: computeTemporalLinks not exposed as standalone function — see test_link_utils.py::test_weight_decreases_with_distance")
  })
  it("minimum link weight is 0.3", () => {
    throw new Error("implement me: computeTemporalLinks not exposed as standalone function — see test_link_utils.py::test_weight_minimum_is_0_3")
  })
  it("maximum 10 temporal links per memory unit", () => {
    throw new Error("implement me: computeTemporalLinks not exposed as standalone function — see test_link_utils.py::test_max_10_links_per_unit")
  })
})

describe("temporal fields written to DB", () => {
  it("occurred_start, occurred_end, and mentioned_at are written to the database after retain", () => {
    throw new Error("implement me: MemoryUnit lacks occurredStart/occurredEnd/mentionedAt fields — see test_temporal_ranges.py::test_temporal_fields_stored")
  })
  it("mentioned_at is close to the event_date provided at retain time", () => {
    throw new Error("implement me: MemoryUnit lacks mentionedAt field — see test_temporal_ranges.py::test_mentioned_at_close_to_event_date")
  })
  it("point event: occurred_start and occurred_end are within the same day", () => {
    throw new Error("implement me: MemoryUnit lacks occurredStart/occurredEnd fields — see test_temporal_ranges.py::test_point_event_same_day")
  })
  it("period event: occurred_start is in the correct month/year (e.g. February 2024)", () => {
    throw new Error("implement me: MemoryUnit lacks occurredStart/occurredEnd fields — see test_temporal_ranges.py::test_period_event_correct_month")
  })
  it("temporal fields are present and populated in search/recall results", () => {
    throw new Error("implement me: MemoryUnit lacks occurredStart/occurredEnd/mentionedAt fields — see test_temporal_ranges.py::test_temporal_fields_in_recall")
  })
})
