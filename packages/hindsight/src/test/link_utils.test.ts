/**
 * Core parity port for test_link_utils.py.
 */

import { describe, it, expect } from "bun:test"
import {
  computeTemporalLinks,
  computeTemporalQueryBounds,
  normalizeTemporalDate,
} from "../retain-link-utils"

const HOUR_MS = 60 * 60 * 1000
const JS_DATE_MIN_MS = -8_640_000_000_000_000
const JS_DATE_MAX_MS = 8_640_000_000_000_000

function utcMs(
  year: number,
  monthZeroBased: number,
  day: number,
  hour: number = 0,
  minute: number = 0,
): number {
  return Date.UTC(year, monthZeroBased, day, hour, minute, 0, 0)
}

describe("_normalize_datetime parity", () => {
  it("none returns none", () => {
    expect(normalizeTemporalDate(null)).toBeNull()
    expect(normalizeTemporalDate(undefined)).toBeNull()
  })

  it("naive datetime becomes utc comparable epoch", () => {
    const value = new Date(utcMs(2024, 5, 15, 10, 30))
    const normalized = normalizeTemporalDate(value)
    expect(normalized).toBe(utcMs(2024, 5, 15, 10, 30))
  })

  it("aware datetime unchanged", () => {
    const aware = new Date("2024-06-15T10:30:00.000Z")
    expect(normalizeTemporalDate(aware)).toBe(aware.getTime())
  })

  it("mixed datetimes can be compared", () => {
    const fromDate = normalizeTemporalDate(new Date("2024-06-15T10:30:00.000Z"))
    const fromEpoch = normalizeTemporalDate(utcMs(2024, 5, 15, 10, 30))
    expect(fromDate).toBe(fromEpoch)
  })
})

describe("compute_temporal_query_bounds parity", () => {
  it("empty units returns none", () => {
    const bounds = computeTemporalQueryBounds({})
    expect(bounds.minDate).toBeNull()
    expect(bounds.maxDate).toBeNull()
  })

  it("single unit normal date", () => {
    const bounds = computeTemporalQueryBounds(
      { "unit-1": utcMs(2024, 5, 15, 12, 0) },
      24,
    )
    expect(bounds.minDate).toBe(utcMs(2024, 5, 14, 12, 0))
    expect(bounds.maxDate).toBe(utcMs(2024, 5, 16, 12, 0))
  })

  it("multiple units", () => {
    const bounds = computeTemporalQueryBounds(
      {
        "unit-1": utcMs(2024, 5, 10, 12, 0),
        "unit-2": utcMs(2024, 5, 15, 12, 0),
        "unit-3": utcMs(2024, 5, 20, 12, 0),
      },
      24,
    )
    expect(bounds.minDate).toBe(utcMs(2024, 5, 9, 12, 0))
    expect(bounds.maxDate).toBe(utcMs(2024, 5, 21, 12, 0))
  })

  it("mixed naive and aware datetimes", () => {
    const bounds = computeTemporalQueryBounds(
      {
        "unit-1": utcMs(2024, 5, 10, 12, 0),
        "unit-2": new Date("2024-06-15T12:00:00.000Z"),
      },
      24,
    )
    expect(bounds.minDate).not.toBeNull()
    expect(bounds.maxDate).not.toBeNull()
  })

  it("overflow near datetime min", () => {
    const bounds = computeTemporalQueryBounds(
      { "unit-1": JS_DATE_MIN_MS + 24 * HOUR_MS },
      48,
    )
    expect(bounds.minDate).toBe(JS_DATE_MIN_MS)
    expect(bounds.maxDate).toBe(JS_DATE_MIN_MS + 72 * HOUR_MS)
  })

  it("overflow near datetime max", () => {
    const bounds = computeTemporalQueryBounds(
      { "unit-1": JS_DATE_MAX_MS - 24 * HOUR_MS },
      48,
    )
    expect(bounds.minDate).toBe(JS_DATE_MAX_MS - 72 * HOUR_MS)
    expect(bounds.maxDate).toBe(JS_DATE_MAX_MS)
  })
})

describe("compute_temporal_links parity", () => {
  it("empty units returns empty", () => {
    expect(computeTemporalLinks({}, [])).toEqual([])
  })

  it("no candidates returns empty", () => {
    const links = computeTemporalLinks(
      { "unit-1": utcMs(2024, 5, 15, 12, 0) },
      [],
      24,
    )
    expect(links).toEqual([])
  })

  it("candidate within temporal window creates a link", () => {
    const links = computeTemporalLinks(
      { "unit-1": utcMs(2024, 5, 15, 12, 0) },
      [{ id: "candidate-1", eventDate: utcMs(2024, 5, 15, 10, 0) }],
      24,
    )

    expect(links).toHaveLength(1)
    expect(links[0]![0]).toBe("unit-1")
    expect(links[0]![1]).toBe("candidate-1")
    expect(links[0]![2]).toBe("temporal")
    expect(links[0]![4]).toBeNull()
    expect(links[0]![3]).toBeGreaterThan(0.9)
  })

  it("candidate outside temporal window creates no link", () => {
    const links = computeTemporalLinks(
      { "unit-1": utcMs(2024, 5, 15, 12, 0) },
      [{ id: "candidate-1", eventDate: utcMs(2024, 5, 10, 12, 0) }],
      24,
    )
    expect(links).toHaveLength(0)
  })

  it("weight decreases with distance", () => {
    const links = computeTemporalLinks(
      { "unit-1": utcMs(2024, 5, 15, 12, 0) },
      [
        { id: "close", eventDate: utcMs(2024, 5, 15, 11, 0) },
        { id: "far", eventDate: utcMs(2024, 5, 14, 18, 0) },
      ],
      24,
    )
    const closeWeight = links.find((link) => link[1] === "close")![3]
    const farWeight = links.find((link) => link[1] === "far")![3]
    expect(closeWeight).toBeGreaterThan(farWeight)
  })

  it("weight minimum is 0.3", () => {
    const links = computeTemporalLinks(
      { "unit-1": utcMs(2024, 5, 15, 12, 0) },
      [{ id: "c1", eventDate: utcMs(2024, 5, 14, 13, 0) }],
      24,
    )
    expect(links).toHaveLength(1)
    expect(links[0]![3]).toBeGreaterThanOrEqual(0.3)
  })

  it("max 10 links per unit", () => {
    const candidates = Array.from({ length: 15 }, (_, index) => ({
      id: `candidate-${index}`,
      eventDate: utcMs(2024, 5, 15, 11, 0),
    }))
    const links = computeTemporalLinks(
      { "unit-1": utcMs(2024, 5, 15, 12, 0) },
      candidates,
      24,
    )
    expect(links).toHaveLength(10)
  })

  it("multiple units multiple candidates", () => {
    const links = computeTemporalLinks(
      {
        "unit-1": utcMs(2024, 5, 15, 12, 0),
        "unit-2": utcMs(2024, 5, 20, 12, 0),
      },
      [
        { id: "c1", eventDate: utcMs(2024, 5, 15, 10, 0) },
        { id: "c2", eventDate: utcMs(2024, 5, 20, 10, 0) },
        { id: "c3", eventDate: utcMs(2024, 5, 17, 12, 0) },
      ],
      24,
    )

    const unit1Links = links.filter((link) => link[0] === "unit-1")
    const unit2Links = links.filter((link) => link[0] === "unit-2")
    expect(unit1Links).toHaveLength(1)
    expect(unit1Links[0]![1]).toBe("c1")
    expect(unit2Links).toHaveLength(1)
    expect(unit2Links[0]![1]).toBe("c2")
  })

  it("mixed naive and aware datetimes", () => {
    const links = computeTemporalLinks(
      { "unit-1": utcMs(2024, 5, 15, 12, 0) },
      [{ id: "c1", eventDate: new Date("2024-06-15T10:00:00.000Z") }],
      24,
    )
    expect(links).toHaveLength(1)
  })

  it("overflow near datetime min", () => {
    const links = computeTemporalLinks(
      { "unit-1": JS_DATE_MIN_MS + 24 * HOUR_MS },
      [{ id: "c1", eventDate: JS_DATE_MIN_MS + 12 * HOUR_MS }],
      48,
    )
    expect(links).toHaveLength(1)
  })

  it("overflow near datetime max", () => {
    const links = computeTemporalLinks(
      { "unit-1": JS_DATE_MAX_MS - 24 * HOUR_MS },
      [{ id: "c1", eventDate: JS_DATE_MAX_MS - 12 * HOUR_MS }],
      48,
    )
    expect(links).toHaveLength(1)
  })

  it("preserves candidate order before max-links cap", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      id: `candidate-${index}`,
      eventDate: utcMs(2024, 5, 15, 11, 0),
    }))
    const links = computeTemporalLinks(
      { "unit-1": utcMs(2024, 5, 15, 12, 0) },
      candidates,
      24,
    )
    expect(links).toHaveLength(10)
    expect(links.map((link) => link[1])).toEqual(
      candidates.slice(0, 10).map((candidate) => candidate.id),
    )
  })
})
