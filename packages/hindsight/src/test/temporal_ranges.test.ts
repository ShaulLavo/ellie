/**
 * Core parity port for test_temporal_ranges.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"
import { extractTemporalRange } from "../temporal"

describe("Core parity: test_temporal_ranges.py", () => {
  const fixedNow = new Date("2025-06-20T12:00:00.000Z")

  it("temporal ranges are written", async () => {
    const range = extractTemporalRange("in the last 10 days", fixedNow)
    expect(range).toBeDefined()
  })

})
