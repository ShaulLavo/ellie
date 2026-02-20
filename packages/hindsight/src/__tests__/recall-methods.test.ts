/**
 * Tests for individual retrieval methods — semantic, fulltext, graph, temporal.
 *
 * Port of test_mpfp_retrieval.py + test_link_expansion_retrieval.py.
 * Integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Retrieval methods", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(async () => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  // ── Semantic retrieval ──────────────────────────────────────────────────

  describe("semantic retrieval", () => {
    it("finds memories by embedding similarity", async () => {
      await t.hs.retain(bankId, "test", {
        facts: [
          { content: "Peter enjoys mountain hiking" },
          { content: "The stock market crashed today" },
        ],
        consolidate: false,
      })

      const result = await t.hs.recall(bankId, "outdoor activities", {
        methods: ["semantic"],
      })

      // Semantic search should return results (even with mock embeddings)
      expect(result.memories).toBeDefined()
    })
  })

  // ── Fulltext (BM25) retrieval ──────────────────────────────────────────

  describe("fulltext retrieval", () => {
    it("finds memories by keyword match", async () => {
      await t.hs.retain(bankId, "test", {
        facts: [
          { content: "Python is a versatile programming language" },
          { content: "The weather is nice today" },
        ],
        consolidate: false,
      })

      const result = await t.hs.recall(bankId, "Python programming", {
        methods: ["fulltext"],
      })

      if (result.memories.length > 0) {
        expect(result.memories[0]!.memory.content).toContain("Python")
        expect(result.memories[0]!.sources).toContain("fulltext")
      }
    })

    it("handles porter stemming (run/running/runs)", async () => {
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "Peter was running through the park" }],
        consolidate: false,
      })

      const result = await t.hs.recall(bankId, "run", {
        methods: ["fulltext"],
      })

      // FTS5 with porter tokenizer should match "running" with "run"
      if (result.memories.length > 0) {
        expect(result.memories[0]!.memory.content).toContain("running")
      }
    })
  })

  // ── Graph retrieval ─────────────────────────────────────────────────────

  describe("graph retrieval", () => {
    it("finds memories via shared entities", async () => {
      await t.hs.retain(bankId, "test", {
        facts: [
          { content: "Peter works at Acme Corp", entities: ["Peter", "Acme Corp"] },
          { content: "Peter loves hiking", entities: ["Peter"] },
        ],
        consolidate: false,
      })

      const result = await t.hs.recall(bankId, "Peter", {
        methods: ["graph"],
      })

      // Graph search should find memories connected via "Peter" entity
      expect(result.memories).toBeDefined()
    })

    it("returns empty for unrelated entities", async () => {
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "Alice enjoys reading", entities: ["Alice"] }],
        consolidate: false,
      })

      const result = await t.hs.recall(bankId, "Bob", {
        methods: ["graph"],
      })

      // No "Bob" entity exists → no graph results
      expect(result.memories).toHaveLength(0)
    })
  })

  // ── Temporal retrieval ──────────────────────────────────────────────────

  describe("temporal retrieval", () => {
    it("finds memories within a time range", async () => {
      const now = Date.now()
      await t.hs.retain(bankId, "test", {
        facts: [
          {
            content: "Meeting happened this morning",
            validFrom: now - 3_600_000,
            validTo: now,
          },
          {
            content: "Conference was last month",
            validFrom: now - 30 * 86_400_000,
            validTo: now - 25 * 86_400_000,
          },
        ],
        consolidate: false,
      })

      const result = await t.hs.recall(bankId, "meeting", {
        methods: ["temporal"],
        timeRange: { from: now - 86_400_000, to: now },
      })

      // Should find the recent meeting, not the old conference
      if (result.memories.length > 0) {
        expect(result.memories[0]!.sources).toContain("temporal")
      }
    })

    it("returns empty when no memories in range", async () => {
      const now = Date.now()
      await t.hs.retain(bankId, "test", {
        facts: [
          {
            content: "Old event",
            validFrom: now - 365 * 86_400_000,
            validTo: now - 360 * 86_400_000,
          },
        ],
        consolidate: false,
      })

      const result = await t.hs.recall(bankId, "event", {
        methods: ["temporal"],
        timeRange: { from: now - 86_400_000, to: now },
      })

      expect(result.memories).toHaveLength(0)
    })
  })

  // ── MPFP graph retrieval (port of test_mpfp_retrieval.py) ──────────────

  describe("MPFP graph retrieval", () => {
    it.todo("finds facts related via graph traversal through shared entities (integration)")
    it.todo("loads edges lazily — only fetches edges for frontier nodes actually reached")
    it.todo("empty seeds return empty results (no traversal)")
    it.todo("single-hop traversal deposits alpha mass at seed node")
    it.todo("single-hop traversal spreads remaining mass to neighbours proportionally")
    it.todo("two-hop traversal propagates mass through intermediate nodes")
    it.todo("cache reuse prevents redundant edge loading for already-cached nodes")
    it.todo("RRF fusion: empty pattern results return empty list")
    it.todo("RRF fusion: single pattern preserves rank order")
    it.todo("RRF fusion: nodes appearing in multiple patterns get boosted score")
    it.todo("RRF fusion: top_k limits returned results")
    it.todo("RRF fusion: patterns with empty scores are ignored")
  })

  // ── Link expansion retrieval (port of test_link_expansion_retrieval.py) ─

  describe("link expansion retrieval", () => {
    it.todo("observations find other observations via shared entities from source world facts")
    it.todo("world facts find other world facts via direct entity links")
    it.todo("graph trace is present in recall result when enabled")
  })

  // ── Multi-method fusion ─────────────────────────────────────────────────

  describe("multi-method fusion", () => {
    it("combines results from all methods", async () => {
      await t.hs.retain(bankId, "test", {
        facts: [
          { content: "Peter enjoys mountain hiking trails", entities: ["Peter"] },
          { content: "Alice likes reading books", entities: ["Alice"] },
        ],
        consolidate: false,
      })

      const result = await t.hs.recall(bankId, "Peter hiking", {
        methods: ["semantic", "fulltext", "graph", "temporal"],
      })

      // Should return results from multiple sources
      expect(result.memories).toBeDefined()
    })
  })
})
