/**
 * Tests for individual retrieval methods — semantic, fulltext, graph, temporal.
 *
 * Port of test_mpfp_retrieval.py + test_link_expansion_retrieval.py.
 * Integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { eq } from "drizzle-orm"
import { createTestHindsight, createTestBank, implementMe, type TestHindsight } from "./setup"
import { searchGraph } from "../retrieval/graph"
import type { HindsightDatabase } from "../db"
import type { EmbeddingStore } from "../embedding"

function getInternals(hs: TestHindsight["hs"]): {
  hdb: HindsightDatabase
  memoryVec: EmbeddingStore
} {
  return hs as unknown as {
    hdb: HindsightDatabase
    memoryVec: EmbeddingStore
  }
}

describe("Retrieval methods", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
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

      expect(result.memories.length).toBeGreaterThan(0)
      expect(result.memories[0]!.sources).toContain("semantic")
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

      expect(result.memories.length).toBeGreaterThan(0)
      expect(result.memories[0]!.memory.content).toContain("Python")
      expect(result.memories[0]!.sources).toContain("fulltext")
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
      expect(result.memories.length).toBeGreaterThan(0)
      expect(result.memories[0]!.memory.content).toContain("running")
    })
  })

  // ── Graph retrieval ─────────────────────────────────────────────────────

  describe("graph retrieval", () => {
    it("finds memories via shared entities", async () => {
      const retained = await t.hs.retain(bankId, "test", {
        facts: [
          { content: "Peter works at Acme Corp", entities: ["Peter", "Acme Corp"] },
          { content: "Peter loves hiking", entities: ["Peter"] },
        ],
        consolidate: false,
      })

      const acmeFact = retained.memories.find((m) => m.content.includes("Acme Corp"))!
      const hikingFact = retained.memories.find((m) => m.content.includes("hiking"))!

      // Seed from "Peter works at Acme Corp" → entity "Peter" links to "Peter loves hiking"
      const { hdb, memoryVec } = getInternals(t.hs)
      const graphResults = await searchGraph(hdb, memoryVec, bankId, "ignored", 10, {
        seedMemoryIds: [acmeFact.id],
      })

      expect(graphResults.length).toBeGreaterThan(0)
      expect(graphResults.some((r) => r.id === hikingFact.id)).toBe(true)
    })

    it("expands directional causal links from seed memories", async () => {
      t.adapter.setResponse(
        JSON.stringify({
          facts: [
            {
              content: "Heavy rain started in the afternoon",
              factType: "world",
              confidence: 1,
              validFrom: null,
              validTo: null,
              entities: [],
              tags: [],
              causalRelations: [],
            },
            {
              content: "The hiking trail became muddy",
              factType: "world",
              confidence: 1,
              validFrom: null,
              validTo: null,
              entities: [],
              tags: [],
              causalRelations: [{ targetIndex: 0, relationType: "causes", strength: 0.9 }],
            },
          ],
        }),
      )

      const retained = await t.hs.retain(bankId, "storm report", {
        consolidate: false,
      })

      const cause = retained.memories.find((m) =>
        m.content.includes("Heavy rain"),
      )
      const effect = retained.memories.find((m) =>
        m.content.includes("muddy"),
      )

      expect(cause).toBeDefined()
      expect(effect).toBeDefined()

      const { hdb, memoryVec } = getInternals(t.hs)
      const graphResults = await searchGraph(
        hdb,
        memoryVec,
        bankId,
        "ignored",
        10,
        {
          factTypes: ["world"],
          seedMemoryIds: [effect!.id],
        },
      )

      expect(graphResults.some((r) => r.id === cause!.id)).toBe(true)
    })

    it("applies entity frequency filtering", async () => {
      const retained = await t.hs.retain(bankId, "test", {
        facts: [
          { content: "Alice writes Python services", factType: "world", entities: ["Alice", "Python"] },
          { content: "Bob writes Python pipelines", factType: "world", entities: ["Bob", "Python"] },
          { content: "Carol writes Python scripts", factType: "world", entities: ["Carol", "Python"] },
        ],
        consolidate: false,
      })

      const alice = retained.memories.find((m) => m.content.includes("Alice"))
      expect(alice).toBeDefined()

      const { hdb, memoryVec } = getInternals(t.hs)
      const strictResults = await searchGraph(
        hdb,
        memoryVec,
        bankId,
        "ignored",
        10,
        {
          factTypes: ["world"],
          seedMemoryIds: [alice!.id],
          maxEntityFrequency: 1,
          causalWeightThreshold: 1.1,
        },
      )
      const relaxedResults = await searchGraph(
        hdb,
        memoryVec,
        bankId,
        "ignored",
        10,
        {
          factTypes: ["world"],
          seedMemoryIds: [alice!.id],
          maxEntityFrequency: 100,
          causalWeightThreshold: 1.1,
        },
      )

      expect(strictResults).toHaveLength(0)
      expect(relaxedResults.length).toBeGreaterThan(0)
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
      expect(result.memories.length).toBeGreaterThan(0)
      expect(result.memories[0]!.sources).toContain("temporal")
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
    it("finds facts related via graph traversal through shared entities (integration)", () => {
      implementMe(
        "MPFP graph traversal not exposed as standalone function",
        "test_mpfp_retrieval.py::test_graph_traversal_shared_entities",
      )
    })

    it("loads edges lazily — only fetches edges for frontier nodes actually reached", () => {
      implementMe(
        "MPFP lazy edge loading not exposed for testing",
        "test_mpfp_retrieval.py::test_lazy_edge_loading",
      )
    })

    it("empty seeds return empty results (no traversal)", () => {
      implementMe(
        "MPFP empty seeds behavior not exposed for testing",
        "test_mpfp_retrieval.py::test_empty_seeds",
      )
    })

    it("single-hop traversal deposits alpha mass at seed node", () => {
      implementMe(
        "MPFP alpha mass deposit not exposed for testing",
        "test_mpfp_retrieval.py::test_single_hop_alpha",
      )
    })

    it("single-hop traversal spreads remaining mass to neighbours proportionally", () => {
      implementMe(
        "MPFP mass spreading not exposed for testing",
        "test_mpfp_retrieval.py::test_single_hop_spread",
      )
    })

    it("two-hop traversal propagates mass through intermediate nodes", () => {
      implementMe(
        "MPFP two-hop propagation not exposed for testing",
        "test_mpfp_retrieval.py::test_two_hop_propagation",
      )
    })

    it("cache reuse prevents redundant edge loading for already-cached nodes", () => {
      implementMe(
        "MPFP cache reuse not exposed for testing",
        "test_mpfp_retrieval.py::test_cache_reuse",
      )
    })

    it("RRF fusion: empty pattern results return empty list", () => {
      implementMe(
        "MPFP RRF fusion internals not exposed for testing",
        "test_mpfp_retrieval.py::test_rrf_empty",
      )
    })

    it("RRF fusion: single pattern preserves rank order", () => {
      implementMe(
        "MPFP RRF fusion internals not exposed for testing",
        "test_mpfp_retrieval.py::test_rrf_single_pattern",
      )
    })

    it("RRF fusion: nodes appearing in multiple patterns get boosted score", () => {
      implementMe(
        "MPFP RRF fusion internals not exposed for testing",
        "test_mpfp_retrieval.py::test_rrf_boost",
      )
    })

    it("RRF fusion: top_k limits returned results", () => {
      implementMe(
        "MPFP RRF fusion internals not exposed for testing",
        "test_mpfp_retrieval.py::test_rrf_top_k",
      )
    })

    it("RRF fusion: patterns with empty scores are ignored", () => {
      implementMe(
        "MPFP RRF fusion internals not exposed for testing",
        "test_mpfp_retrieval.py::test_rrf_empty_scores",
      )
    })
  })

  // ── Link expansion retrieval (port of test_link_expansion_retrieval.py) ─

  describe("link expansion retrieval", () => {
    it("observations traverse source_memory_ids to find related observations", async () => {
      t.adapter.setResponses([
        JSON.stringify([
          {
            action: "create",
            text: "Alice works with Python APIs",
            reason: "Durable profile detail",
          },
        ]),
        JSON.stringify([
          {
            action: "create",
            text: "Bob builds Python data pipelines",
            reason: "Durable profile detail",
          },
        ]),
      ])

      await t.hs.retain(bankId, "test", {
        facts: [
          {
            content: "Alice works with Python at TechCorp",
            factType: "world",
            entities: ["Alice", "Python", "TechCorp"],
          },
          {
            content: "Bob uses Python at DataSoft",
            factType: "world",
            entities: ["Bob", "Python", "DataSoft"],
          },
        ],
        consolidate: false,
      })

      await t.hs.consolidate(bankId)

      const { hdb, memoryVec } = getInternals(t.hs)
      const observations = hdb.db
        .select({
          id: hdb.schema.memoryUnits.id,
          content: hdb.schema.memoryUnits.content,
        })
        .from(hdb.schema.memoryUnits)
        .where(eq(hdb.schema.memoryUnits.factType, "observation"))
        .all()

      expect(observations.length).toBeGreaterThanOrEqual(2)

      const aliceObs = observations.find((obs) => obs.content.includes("Alice"))
      const bobObs = observations.find((obs) => obs.content.includes("Bob"))
      expect(aliceObs).toBeDefined()
      expect(bobObs).toBeDefined()

      const graphResults = await searchGraph(
        hdb,
        memoryVec,
        bankId,
        "ignored",
        10,
        {
          factTypes: ["observation"],
          seedMemoryIds: [aliceObs!.id],
        },
      )

      expect(graphResults.some((r) => r.id === bobObs!.id)).toBe(true)
    })

    it("uses fallback memory_links (semantic/temporal/entity) when primary expansion has no hits", async () => {
      const retained = await t.hs.retain(bankId, "test", {
        facts: [
          { content: "Quantum computing roadmap update", factType: "world" },
          { content: "Compiler optimization milestone reached", factType: "world" },
        ],
        consolidate: false,
        dedupThreshold: 0,
      })

      expect(retained.memories).toHaveLength(2)
      const source = retained.memories[0]!
      const target = retained.memories[1]!
      const { hdb, memoryVec } = getInternals(t.hs)

      hdb.db
        .insert(hdb.schema.memoryLinks)
        .values({
          id: crypto.randomUUID(),
          bankId,
          sourceId: source.id,
          targetId: target.id,
          linkType: "semantic",
          weight: 0.9,
          createdAt: Date.now(),
        })
        .run()

      const graphResults = await searchGraph(
        hdb,
        memoryVec,
        bankId,
        "ignored",
        10,
        {
          factTypes: ["world"],
          seedMemoryIds: [source.id],
        },
      )

      expect(graphResults.some((hit) => hit.id === target.id)).toBe(true)
    })

    it("merges temporal seeds with semantic seeds", async () => {
      const retained = await t.hs.retain(bankId, "test", {
        facts: [
          { content: "Alice writes backend services", factType: "world", entities: ["Alice"] },
          { content: "Alice maintains deployment scripts", factType: "world", entities: ["Alice"] },
        ],
        consolidate: false,
        dedupThreshold: 0,
      })

      const first = retained.memories.find((memory) =>
        memory.content.includes("backend"),
      )
      const second = retained.memories.find((memory) =>
        memory.content.includes("deployment"),
      )
      expect(first).toBeDefined()
      expect(second).toBeDefined()

      const { hdb, memoryVec } = getInternals(t.hs)
      const graphResults = await searchGraph(
        hdb,
        memoryVec,
        bankId,
        "query that should not seed semantically",
        10,
        {
          factTypes: ["world"],
          seedThreshold: 1,
          temporalSeedMemoryIds: [first!.id],
        },
      )

      expect(graphResults.some((hit) => hit.id === second!.id)).toBe(true)
    })
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

      // Should return results — at least fulltext + graph should match "Peter hiking"
      expect(result.memories.length).toBeGreaterThan(0)
    })
  })
})
