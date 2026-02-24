/**
 * Tests for Phase 2 dataset generation.
 *
 * Verifies that generated datasets meet the minimum size requirements
 * and are deterministic (same seed => same output).
 */

import { describe, it, expect } from "bun:test"
import {
  generateRollingIngestDataset,
  generateTemporalNarrativeDataset,
  toJsonl,
} from "../phase2-dataset-gen"

describe("generateRollingIngestDataset", () => {
  it("generates at least 800 events by default", () => {
    const events = generateRollingIngestDataset()
    expect(events.length).toBeGreaterThanOrEqual(800)
  })

  it("generates the requested number of events", () => {
    const events = generateRollingIngestDataset(1000)
    expect(events).toHaveLength(1000)
  })

  it("all events have required fields", () => {
    const events = generateRollingIngestDataset(10, 42)
    for (const event of events) {
      expect(event.eventId).toBeDefined()
      expect(event.clusterId).toBeDefined()
      expect(event.content).toBeDefined()
      expect(event.entity).toBeDefined()
      expect(event.attribute).toBeDefined()
      expect(event.value).toBeDefined()
      expect(event.scope).toBeDefined()
      expect(event.timestamp).toBeDefined()
      expect(event.factType).toBeDefined()
      expect(typeof event.timestamp).toBe("number")
    }
  })

  it("events are sorted by timestamp", () => {
    const events = generateRollingIngestDataset(100, 42)
    for (let i = 0; i < events.length - 1; i++) {
      expect(events[i]!.timestamp).toBeLessThanOrEqual(events[i + 1]!.timestamp)
    }
  })

  it("is deterministic (same seed => same output)", () => {
    const events1 = generateRollingIngestDataset(100, 42)
    const events2 = generateRollingIngestDataset(100, 42)
    expect(events1).toEqual(events2)
  })

  it("different seeds produce different output", () => {
    const events1 = generateRollingIngestDataset(100, 42)
    const events2 = generateRollingIngestDataset(100, 99)
    // Not all events will differ, but at least some should
    const differentCount = events1.filter(
      (e, i) => e.content !== events2[i]!.content,
    ).length
    expect(differentCount).toBeGreaterThan(0)
  })

  it("contains some duplicate cluster entries", () => {
    const events = generateRollingIngestDataset(800, 42)
    const clusterCounts = new Map<string, number>()
    for (const event of events) {
      clusterCounts.set(
        event.clusterId,
        (clusterCounts.get(event.clusterId) ?? 0) + 1,
      )
    }
    const hasDuplicates = [...clusterCounts.values()].some((c) => c > 1)
    expect(hasDuplicates).toBe(true)
  })

  it("has labeled cluster_id, entity, attribute, value, scope fields", () => {
    const events = generateRollingIngestDataset(10, 42)
    const event = events[0]!
    expect(typeof event.clusterId).toBe("string")
    expect(typeof event.entity).toBe("string")
    expect(typeof event.attribute).toBe("string")
    expect(typeof event.value).toBe("string")
    expect(typeof event.scope).toBe("string")
  })
})

describe("generateTemporalNarrativeDataset", () => {
  it("generates at least 200 questions by default", () => {
    const questions = generateTemporalNarrativeDataset()
    expect(questions.length).toBeGreaterThanOrEqual(200)
  })

  it("generates the requested number of questions", () => {
    const questions = generateTemporalNarrativeDataset(100)
    expect(questions).toHaveLength(100)
  })

  it("all questions have required fields", () => {
    const questions = generateTemporalNarrativeDataset(10, 800, 42)
    for (const q of questions) {
      expect(q.questionId).toBeDefined()
      expect(q.question).toBeDefined()
      expect(q.anchorMemoryId).toBeDefined()
      expect(q.expectedOrderedMemoryIds).toBeDefined()
      expect(q.direction).toBeDefined()
      expect(Array.isArray(q.expectedOrderedMemoryIds)).toBe(true)
      expect(["before", "after", "both"]).toContain(q.direction)
    }
  })

  it("expected memory IDs are in ascending order", () => {
    const questions = generateTemporalNarrativeDataset(50, 800, 42)
    for (const q of questions) {
      for (let i = 0; i < q.expectedOrderedMemoryIds.length - 1; i++) {
        expect(
          q.expectedOrderedMemoryIds[i]!.localeCompare(
            q.expectedOrderedMemoryIds[i + 1]!,
          ),
        ).toBeLessThan(0)
      }
    }
  })

  it("is deterministic (same seed => same output)", () => {
    const q1 = generateTemporalNarrativeDataset(50, 800, 42)
    const q2 = generateTemporalNarrativeDataset(50, 800, 42)
    expect(q1).toEqual(q2)
  })
})

describe("toJsonl", () => {
  it("serializes items to JSONL format", () => {
    const items = [{ a: 1 }, { b: 2 }]
    const result = toJsonl(items)
    const lines = result.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1 })
    expect(JSON.parse(lines[1]!)).toEqual({ b: 2 })
  })

  it("handles empty array", () => {
    const result = toJsonl([])
    expect(result).toBe("\n")
  })
})
