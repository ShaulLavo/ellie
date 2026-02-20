/**
 * Tests for consolidation — raw facts → observations.
 *
 * Port of test_consolidation.py.
 * Integration tests — needs DB + mock adapter for LLM consolidation decisions.
 *
 * NOTE: Most consolidation tests require a mock adapter that returns
 * well-formed consolidation actions AND real DB side-effects to verify.
 * Tests that only check `toBeDefined()` or `>= 0` on mock-driven results
 * are false passes and are marked .todo until the mock adapter supports
 * verifiable consolidation flows.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Consolidation", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  // ── Early-return paths (legit — no LLM involved) ─────────────────────

  describe("early returns", () => {
    it("returns zero counts for empty bank", async () => {
      const result = await t.hs.consolidate(bankId)
      expect(result.memoriesProcessed).toBe(0)
      expect(result.observationsCreated).toBe(0)
      expect(result.observationsUpdated).toBe(0)
      expect(result.observationsMerged).toBe(0)
      expect(result.skipped).toBe(0)
    })
  })

  describe("action execution", () => {
    it("counts explicit skip actions", async () => {
      await t.hs.retain(bankId, "ephemeral source", {
        facts: [{ content: "It is sunny right now." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([{ action: "skip", reason: "ephemeral state" }]),
      )

      const result = await t.hs.consolidate(bankId)
      expect(result.memoriesProcessed).toBe(1)
      expect(result.observationsCreated).toBe(0)
      expect(result.observationsUpdated).toBe(0)
      expect(result.observationsMerged).toBe(0)
      expect(result.skipped).toBe(1)
    })

    it("merges multiple observations into one", async () => {
      await t.hs.retain(bankId, "source 1", {
        facts: [{ content: "Alice likes sushi." }],
        consolidate: false,
        dedupThreshold: 0,
      })
      await t.hs.retain(bankId, "source 2", {
        facts: [{ content: "Alice likes Japanese food." }],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponses([
        JSON.stringify([
          {
            action: "create",
            text: "Alice likes sushi.",
            reason: "durable preference",
          },
        ]),
        JSON.stringify([
          {
            action: "create",
            text: "Alice likes Japanese food.",
            reason: "durable preference",
          },
        ]),
      ])

      const firstPass = await t.hs.consolidate(bankId)
      expect(firstPass.observationsCreated).toBe(2)

      const listObservations = () => {
        const hdb = (t.hs as any).hdb
        return hdb.sqlite
          .prepare(
            `SELECT id, content, source_memory_ids
             FROM hs_memory_units
             WHERE bank_id = ? AND fact_type = 'observation'
             ORDER BY created_at ASC`,
          )
          .all(bankId) as Array<{
            id: string
            content: string
            source_memory_ids: string | null
          }>
      }

      const initialObservations = listObservations()
      expect(initialObservations).toHaveLength(2)
      const observationIds = initialObservations.map((obs) => obs.id)

      await t.hs.retain(bankId, "source 3", {
        facts: [{ content: "Alice often chooses sushi restaurants." }],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponse(
        JSON.stringify([
          {
            action: "merge",
            observationIds,
            text: "Alice likes sushi and Japanese food.",
            reason: "same durable preference cluster",
          },
        ]),
      )

      const secondPass = await t.hs.consolidate(bankId)
      expect(secondPass.observationsMerged).toBe(1)
      expect(secondPass.observationsCreated).toBe(0)
      expect(secondPass.observationsUpdated).toBe(0)
      expect(secondPass.skipped).toBe(0)

      const mergedObservations = listObservations()
      expect(mergedObservations).toHaveLength(1)
      expect(mergedObservations[0]!.content).toBe(
        "Alice likes sushi and Japanese food.",
      )

      const sourceIds = mergedObservations[0]!.source_memory_ids
        ? (JSON.parse(mergedObservations[0]!.source_memory_ids!) as string[])
        : []
      expect(sourceIds.length).toBeGreaterThanOrEqual(3)
    })
  })

  // ── Basic consolidation (TDD — need verifiable mock adapter) ─────────

  describe("basic consolidation", () => {
    it.todo("consolidate returns a ConsolidateResult with correct counts")
    it.todo("processes unconsolidated memories (memoriesProcessed > 0)")
    it.todo("processes multiple related memories and checks structure")
    it.todo("respects last_consolidated_at cursor (only processes new memories)")
  })

  // ── Observation creation (TDD) ────────────────────────────────────────

  describe("observation creation", () => {
    it.todo("creates observations with factType 'observation'")
    it.todo("observations are retrievable via recall with factType filter")
    it.todo("observation includes sourceMemoryIds pointing to contributing facts")
    it.todo("proofCount reflects number of supporting source facts")
    it.todo("sourceMemoryIds are valid memory IDs that exist in the DB")
  })

  // ── Recall with observation fact type ─────────────────────────────────

  describe("recall with observation fact type", () => {
    it.todo("recall with observation-only fact type returns observations")
    it.todo("recall with mixed fact types (world + experience + observation) works")
    it.todo("recall with observation-only type and trace enabled works")
  })

  // ── Consolidation disabled ──────────────────────────────────────────

  describe("consolidation disabled", () => {
    it.todo("respects enableConsolidation=false — auto-trigger from retain is skipped")
    it.todo("explicit consolidate() call still works when bank has enableConsolidation=false")
    it.todo("returns disabled status in result")
  })

  // ── Tag routing (port of test_consolidation.py scope tests) ───────────

  describe("tag routing", () => {
    it.todo("same-scope: observation inherits tags from source memories")
    it.todo("scoped fact updates global observation")
    it.todo("cross-scope creates untagged observation")
    it.todo("no match creates observation with fact's tags")
    it.todo("untagged fact can update scoped observation")
    it.todo("tag filtering in recall respects observation tags")
    it.todo("multiple actions from single consolidation pass")
  })

  // ── Temporal range ──────────────────────────────────────────────────

  describe("temporal range expansion", () => {
    it.todo("expands temporal range when updating observation (LEAST start, GREATEST end)")
    it.todo("inherits temporal dates from source memories")
  })

  // ── Entity inheritance ──────────────────────────────────────────────

  describe("entity inheritance", () => {
    it.todo("copies entity links from source facts to observations")
    it.todo("observation inherits entities from all contributing memories")
    it.todo("graph endpoint observations inherit links and entities")
  })

  // ── Update vs create ────────────────────────────────────────────────

  describe("update existing observations", () => {
    it.todo("updates existing observation when LLM decides 'update'")
    it.todo("preserves history on update with previousText and reason")
    it.todo("merges redundant facts into single observation")
    it.todo("keeps different people separate (no cross-entity merge)")
    it.todo("handles contradictions with temporal markers")
  })

  // ── Mental model refresh trigger ────────────────────────────────────

  describe("mental model refresh", () => {
    it.todo("triggers auto-refresh for mental models with matching tags")
    it.todo("does not refresh models without autoRefresh=true")
    it.todo("refreshes models after consolidation completes")
    it.todo("consolidation only refreshes matching tagged models")
  })

  // ── Observation drill-down ──────────────────────────────────────────

  describe("observation drill-down", () => {
    it.todo("search observations returns sourceMemoryIds for drill-down")
    it.todo("sourceMemoryIds point to the memories that built the observation")
  })

  // ── Hierarchical retrieval ──────────────────────────────────────────

  describe("hierarchical retrieval", () => {
    it.todo("mental model takes priority over observation in reflect")
    it.todo("falls back to observation when no mental model exists")
    it.todo("falls back to raw facts for fresh data")
  })
})
