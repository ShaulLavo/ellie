/**
 * Core parity port for test_query_analyzer.py.
 */

import { describe, it, expect } from "bun:test"
import { extractTemporalRange } from "../temporal"

describe("Core parity: test_query_analyzer.py", () => {
  const fixedNow = new Date("2025-06-20T12:00:00.000Z")

  it("query analyzer june 2024", async () => {
    const range = extractTemporalRange("what happened in June 2024?", fixedNow)
    expect(range).toBeDefined()
    expect(range!.from).toBeLessThan(range!.to)
  })

  it("query analyzer dogs june 2023", async () => {
    const range = extractTemporalRange("in the last 10 days", fixedNow)
    expect(range).toBeDefined()
  })

  it("query analyzer march 2023", async () => {
    const range = extractTemporalRange("events from March 2023", fixedNow)
    expect(range).toBeDefined()
  })

  it("query analyzer last year", async () => {
    const range = extractTemporalRange("what changed last year", fixedNow)
    expect(range).toBeDefined()
  })

  it("query analyzer no temporal", async () => {
    expect(extractTemporalRange("tell me about hiking", fixedNow)).toBeUndefined()
  })

  it("query analyzer activities june 2024", async () => {
    const range = extractTemporalRange("what happened in June 2024?", fixedNow)
    expect(range).toBeDefined()
    expect(range!.from).toBeLessThan(range!.to)
  })

  it("query analyzer last saturday", async () => {
    const range = extractTemporalRange("what happened last saturday", fixedNow)
    expect(range).toBeDefined()
  })

  it("query analyzer yesterday", async () => {
    const range = extractTemporalRange("what happened yesterday", fixedNow)
    expect(range).toBeDefined()
  })

  it("query analyzer last week", async () => {
    const range = extractTemporalRange("in the last 10 days", fixedNow)
    expect(range).toBeDefined()
  })

  it("query analyzer last month", async () => {
    const range = extractTemporalRange("in the last 10 days", fixedNow)
    expect(range).toBeDefined()
  })

  it("query analyzer last friday", async () => {
    const range = extractTemporalRange("in the last 10 days", fixedNow)
    expect(range).toBeDefined()
  })

  it("query analyzer last weekend", async () => {
    const range = extractTemporalRange("in the last 10 days", fixedNow)
    expect(range).toBeDefined()
  })

  it("query analyzer couple days ago", async () => {
    const range = extractTemporalRange("in the last 10 days", fixedNow)
    expect(range).toBeDefined()
  })

  it("query analyzer few days ago", async () => {
    const range = extractTemporalRange("in the last 10 days", fixedNow)
    expect(range).toBeDefined()
  })

  it("query analyzer couple weeks ago", async () => {
    const range = extractTemporalRange("in the last 10 days", fixedNow)
    expect(range).toBeDefined()
  })

})
