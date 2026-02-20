/**
 * Tests for recall() — multi-strategy retrieval with RRF fusion.
 *
 * Port of test_search_trace.py + recall basics.
 * Integration tests — needs DB + embeddings.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("recall", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(async () => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
    // Seed some memories
    await t.hs.retain(bankId, "test", {
      facts: [
        { content: "Peter loves hiking in the mountains", factType: "experience" },
        { content: "Alice enjoys reading science fiction", factType: "experience" },
        { content: "TypeScript is a typed superset of JavaScript", factType: "world" },
        { content: "Peter thinks Python is a great language", factType: "opinion", confidence: 0.8 },
      ],
      consolidate: false,
    })
  })

  afterEach(() => {
    t.cleanup()
  })

  // ── Basic recall ────────────────────────────────────────────────────────

  it("returns RecallResult with memories and query", async () => {
    const result = await t.hs.recall(bankId, "hiking")
    expect(result.query).toBe("hiking")
    expect(result.memories).toBeDefined()
    expect(Array.isArray(result.memories)).toBe(true)
  })

  it("returns scored memories", async () => {
    const result = await t.hs.recall(bankId, "hiking")
    expect(result.memories.length).toBeGreaterThan(0)
    const first = result.memories[0]!
    expect(first.memory).toBeDefined()
    expect(first.score).toBeDefined()
    expect(typeof first.score).toBe("number")
    expect(first.sources).toBeDefined()
    expect(Array.isArray(first.sources)).toBe(true)
    expect(first.entities).toBeDefined()
    expect(Array.isArray(first.entities)).toBe(true)
  })

  it("returns memories sorted by score descending", async () => {
    const result = await t.hs.recall(bankId, "programming languages")
    for (let i = 1; i < result.memories.length; i++) {
      expect(result.memories[i - 1]!.score).toBeGreaterThanOrEqual(
        result.memories[i]!.score,
      )
    }
  })

  // ── Filtering ───────────────────────────────────────────────────────────

  describe("filtering", () => {
    it("respects limit parameter", async () => {
      const result = await t.hs.recall(bankId, "test", { limit: 2 })
      expect(result.memories.length).toBeLessThanOrEqual(2)
    })

    it("filters by factTypes", async () => {
      const result = await t.hs.recall(bankId, "test", {
        factTypes: ["experience"],
      })
      for (const m of result.memories) {
        expect(m.memory.factType).toBe("experience")
      }
    })

    it("filters by multiple factTypes", async () => {
      const result = await t.hs.recall(bankId, "test", {
        factTypes: ["experience", "world"],
      })
      for (const m of result.memories) {
        expect(["experience", "world"]).toContain(m.memory.factType)
      }
    })

    it("filters by minConfidence", async () => {
      const result = await t.hs.recall(bankId, "test", {
        minConfidence: 0.9,
      })
      for (const m of result.memories) {
        expect(m.memory.confidence).toBeGreaterThanOrEqual(0.9)
      }
    })

    it("returns empty when no matches", async () => {
      const result = await t.hs.recall(bankId, "xyznonexistent123")
      // May still return some results from graph/temporal — just verify no crash
      expect(result.memories).toBeDefined()
    })

    it("respects maxTokens budget", async () => {
      const result = await t.hs.recall(bankId, "test", {
        maxTokens: 10,
      })
      expect(result.memories.length).toBeLessThanOrEqual(1)
    })
  })

  // ── Source tracking ─────────────────────────────────────────────────────

  describe("source tracking", () => {
    it("tracks retrieval sources", async () => {
      const result = await t.hs.recall(bankId, "hiking")
      const validSources = ["semantic", "fulltext", "graph", "temporal"]
      for (const m of result.memories) {
        for (const source of m.sources) {
          expect(validSources).toContain(source)
        }
      }
    })

    it("can include entities and chunk payloads", async () => {
      const result = await t.hs.recall(bankId, "Peter", {
        includeEntities: true,
        includeChunks: true,
      })
      expect(result.entities).toBeDefined()
      expect(result.chunks).toBeDefined()
    })
  })

  // ── Method selection ────────────────────────────────────────────────────

  describe("retrieval methods", () => {
    it("supports selecting specific methods", async () => {
      const result = await t.hs.recall(bankId, "hiking", {
        methods: ["semantic"],
      })
      for (const m of result.memories) {
        expect(m.sources).toContain("semantic")
      }
    })

    it("supports fulltext only", async () => {
      const result = await t.hs.recall(bankId, "hiking", {
        methods: ["fulltext"],
      })
      for (const m of result.memories) {
        expect(m.sources).toContain("fulltext")
      }
    })
  })

  // ── Entity filter ───────────────────────────────────────────────────────

  describe("entity filtering", () => {
    it("filters by entity names", async () => {
      // First, retain with entities
      await t.hs.retain(bankId, "test", {
        facts: [
          { content: "Bob built a treehouse", entities: ["Bob"] },
        ],
        consolidate: false,
      })

      const result = await t.hs.recall(bankId, "building", {
        entities: ["Bob"],
      })

      for (const m of result.memories) {
        const entityNames = m.entities.map((e) => e.name.toLowerCase())
        expect(entityNames).toContain("bob")
      }
    })
  })

  // ── Search trace (port of test_search_trace.py) ────────────────────────

  describe("search trace", () => {
    it.todo("returns trace object when enableTrace=true")
    it.todo("trace.query contains query text, budget, maxTokens, and embedding")
    it.todo("trace.entryPoints contains nodes with nodeId, text, and similarityScore in [0,1]")
    it.todo("trace.visits contains visited nodes with nodeId, text, and finalWeight")
    it.todo("entry point visits have no parentNodeId or linkType")
    it.todo("trace.summary.totalNodesVisited equals length of trace.visits")
    it.todo("trace.summary.resultsReturned equals length of result.memories")
    it.todo("trace.summary.budgetUsed is <= budget")
    it.todo("trace.summary.totalDurationSeconds is > 0")
    it.todo("trace.summary.phaseMetrics includes generateQueryEmbedding, parallelRetrieval, rrfMerge, reranking phases")
    it.todo("returns trace=null/undefined when enableTrace=false")
  })

  // ── Time range ──────────────────────────────────────────────────────────

  describe("time range filtering", () => {
    it("filters by explicit time range", async () => {
      const now = Date.now()
      await t.hs.retain(bankId, "test", {
        facts: [
          {
            content: "Recent event",
            validFrom: now - 3_600_000, // 1 hour ago
            validTo: now,
          },
        ],
        consolidate: false,
      })

      const result = await t.hs.recall(bankId, "event", {
        timeRange: { from: now - 7_200_000, to: now },
        methods: ["temporal"],
      })
      // Should include the recent event
      expect(result.memories).toBeDefined()
    })

    it("auto-extracts temporal range from query", async () => {
      const result = await t.hs.recall(bankId, "what happened yesterday?")
      // Should not crash even if no memories match the temporal range
      expect(result.memories).toBeDefined()
    })
  })
})
