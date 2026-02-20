/**
 * Tests for fusion.ts — Reciprocal Rank Fusion.
 *
 * Port of test_combined_scoring.py (unit test parts).
 * Pure unit tests — no DB or LLM needed.
 */

import { describe, it, expect } from "bun:test"
import { reciprocalRankFusion } from "../fusion"
import type { RetrievalHit } from "../retrieval/semantic"

function makeHits(
  ids: string[],
  source: string,
): RetrievalHit[] {
  return ids.map((id, rank) => ({
    id,
    score: 1 - rank * 0.1, // decreasing score
    source,
  }))
}

// ════════════════════════════════════════════════════════════════════════════
// RRF score calculation
// ════════════════════════════════════════════════════════════════════════════

describe("reciprocalRankFusion", () => {
  it("scores a single result set correctly", () => {
    const hits = makeHits(["a", "b", "c"], "semantic")
    const fused = reciprocalRankFusion([hits], 10)

    expect(fused).toHaveLength(3)
    // First result: 1/(60 + 0 + 1) = 1/61
    expect(fused[0]!.id).toBe("a")
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 6)
    // Second result: 1/(60 + 1 + 1) = 1/62
    expect(fused[1]!.id).toBe("b")
    expect(fused[1]!.score).toBeCloseTo(1 / 62, 6)
  })

  it("boosts documents appearing in multiple lists", () => {
    const semantic = makeHits(["a", "b", "c"], "semantic")
    const fulltext = makeHits(["b", "d", "a"], "fulltext")

    const fused = reciprocalRankFusion([semantic, fulltext], 10)

    // "a" appears in both: rank 0 in semantic (1/61) + rank 2 in fulltext (1/63)
    // "b" appears in both: rank 1 in semantic (1/62) + rank 0 in fulltext (1/61)
    // "b" should score higher: 1/62 + 1/61 > 1/61 + 1/63
    const scoreA = fused.find((f) => f.id === "a")!.score
    const scoreB = fused.find((f) => f.id === "b")!.score
    expect(scoreB).toBeGreaterThan(scoreA)

    // Both should score higher than single-list items
    const scoreC = fused.find((f) => f.id === "c")!.score
    expect(scoreA).toBeGreaterThan(scoreC)
    expect(scoreB).toBeGreaterThan(scoreC)
  })

  it("tracks sources correctly", () => {
    const semantic = makeHits(["a", "b"], "semantic")
    const fulltext = makeHits(["b", "c"], "fulltext")

    const fused = reciprocalRankFusion([semantic, fulltext], 10)

    const a = fused.find((f) => f.id === "a")!
    expect(a.sources).toEqual(["semantic"])

    const b = fused.find((f) => f.id === "b")!
    expect(b.sources).toContain("semantic")
    expect(b.sources).toContain("fulltext")
    expect(b.sources).toHaveLength(2)

    const c = fused.find((f) => f.id === "c")!
    expect(c.sources).toEqual(["fulltext"])
  })

  it("respects the limit parameter", () => {
    const hits = makeHits(
      ["a", "b", "c", "d", "e", "f", "g"],
      "semantic",
    )
    const fused = reciprocalRankFusion([hits], 3)
    expect(fused).toHaveLength(3)
    expect(fused[0]!.id).toBe("a")
  })

  it("returns sorted by score descending", () => {
    const semantic = makeHits(["a", "b", "c"], "semantic")
    const fulltext = makeHits(["c", "b", "a"], "fulltext")

    const fused = reciprocalRankFusion([semantic, fulltext], 10)

    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1]!.score).toBeGreaterThanOrEqual(fused[i]!.score)
    }
  })

  it("handles empty result sets", () => {
    const fused = reciprocalRankFusion([], 10)
    expect(fused).toHaveLength(0)
  })

  it("handles all empty lists", () => {
    const fused = reciprocalRankFusion([[], [], []], 10)
    expect(fused).toHaveLength(0)
  })

  it("handles single item lists", () => {
    const fused = reciprocalRankFusion(
      [
        [{ id: "a", score: 1, source: "semantic" }],
        [{ id: "a", score: 1, source: "fulltext" }],
      ],
      10,
    )

    expect(fused).toHaveLength(1)
    expect(fused[0]!.id).toBe("a")
    // 1/61 + 1/61 = 2/61
    expect(fused[0]!.score).toBeCloseTo(2 / 61, 6)
  })

  it("merges 4 result sets (all retrieval methods)", () => {
    const semantic = makeHits(["a", "b", "c"], "semantic")
    const fulltext = makeHits(["b", "c", "d"], "fulltext")
    const graph = makeHits(["c", "d", "e"], "graph")
    const temporal = makeHits(["d", "e", "a"], "temporal")

    const fused = reciprocalRankFusion(
      [semantic, fulltext, graph, temporal],
      10,
    )

    // All 5 unique IDs should be present
    const ids = fused.map((f) => f.id)
    expect(ids).toContain("a")
    expect(ids).toContain("b")
    expect(ids).toContain("c")
    expect(ids).toContain("d")
    expect(ids).toContain("e")
  })

  it.todo("RRF scores are normalized to [0, 1] range")

  it.todo("all same scores produce equal RRF output (~0.5 normalized)")
})
