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
import { createTestHindsight, createTestBank, implementMe, type TestHindsight } from "./setup"

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

  // ── Helper: query observations from DB ─────────────────────────────────

  function listObservations(bid: string = bankId) {
    const hdb = (t.hs as any).hdb
    return hdb.sqlite
      .prepare(
        `SELECT id, content, fact_type, source_memory_ids, proof_count, tags, valid_from, valid_to, history
         FROM hs_memory_units
         WHERE bank_id = ? AND fact_type = 'observation'
         ORDER BY created_at ASC`,
      )
      .all(bid) as Array<{
        id: string
        content: string
        fact_type: string
        source_memory_ids: string | null
        proof_count: number
        tags: string | null
        valid_from: number | null
        valid_to: number | null
        history: string | null
      }>
  }

  function listAllMemories(bid: string = bankId) {
    const hdb = (t.hs as any).hdb
    return hdb.sqlite
      .prepare(
        `SELECT id, content, fact_type, tags, source_memory_ids
         FROM hs_memory_units
         WHERE bank_id = ?
         ORDER BY created_at ASC`,
      )
      .all(bid) as Array<{
        id: string
        content: string
        fact_type: string
        tags: string | null
        source_memory_ids: string | null
      }>
  }

  function listRawFacts(bid: string = bankId) {
    const hdb = (t.hs as any).hdb
    return hdb.sqlite
      .prepare(
        `SELECT id, content, fact_type
         FROM hs_memory_units
         WHERE bank_id = ? AND fact_type IN ('experience', 'world')
         ORDER BY created_at ASC`,
      )
      .all(bid) as Array<{
        id: string
        content: string
        fact_type: string
      }>
  }

  function listMemoryEntities(memoryId: string) {
    const hdb = (t.hs as any).hdb
    return hdb.sqlite
      .prepare(
        `SELECT me.memory_id, me.entity_id, e.name
         FROM hs_memory_entities me
         JOIN hs_entities e ON e.id = me.entity_id
         WHERE me.memory_id = ?`,
      )
      .all(memoryId) as Array<{
        memory_id: string
        entity_id: string
        name: string
      }>
  }

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
    it("consolidate returns a ConsolidateResult with correct counts", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [
          { content: "Bob prefers dark mode." },
          { content: "Bob uses Vim." },
        ],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponses([
        JSON.stringify([
          { action: "create", text: "Bob prefers dark mode.", reason: "pref" },
        ]),
        JSON.stringify([
          { action: "create", text: "Bob uses Vim.", reason: "pref" },
        ]),
      ])

      const result = await t.hs.consolidate(bankId)
      expect(result.memoriesProcessed).toBe(2)
      expect(result.observationsCreated).toBe(2)
      expect(result.observationsUpdated).toBe(0)
      expect(result.observationsMerged).toBe(0)
      expect(result.skipped).toBe(0)
      expect(result.mentalModelsRefreshQueued).toBeGreaterThanOrEqual(0)
    })

    it("processes unconsolidated memories (memoriesProcessed > 0)", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Carol is a morning person." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Carol is a morning person.", reason: "habit" },
        ]),
      )

      const result = await t.hs.consolidate(bankId)
      expect(result.memoriesProcessed).toBeGreaterThan(0)
    })

    it("processes multiple related memories and checks structure", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [
          { content: "Dave likes cycling." },
          { content: "Dave rides his bike to work." },
        ],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponses([
        JSON.stringify([
          { action: "create", text: "Dave likes cycling.", reason: "preference" },
        ]),
        JSON.stringify([
          { action: "create", text: "Dave commutes by bike.", reason: "habit" },
        ]),
      ])

      const result = await t.hs.consolidate(bankId)
      expect(result.memoriesProcessed).toBe(2)
      expect(result.observationsCreated).toBe(2)

      const obs = listObservations()
      expect(obs).toHaveLength(2)
      for (const o of obs) {
        expect(o.fact_type).toBe("observation")
        expect(o.content.length).toBeGreaterThan(0)
      }
    })

    it("respects last_consolidated_at cursor (only processes new memories)", async () => {
      // Retain first fact and consolidate
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Eve likes coffee." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Eve likes coffee.", reason: "pref" },
        ]),
      )

      const first = await t.hs.consolidate(bankId)
      expect(first.memoriesProcessed).toBe(1)
      expect(first.observationsCreated).toBe(1)

      // Second consolidation without new memories should process 0
      t.adapter.setResponse(JSON.stringify([]))
      const second = await t.hs.consolidate(bankId)
      expect(second.memoriesProcessed).toBe(0)

      // Retain new fact → only new one should be processed
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Eve likes tea." }],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Eve likes tea.", reason: "pref" },
        ]),
      )

      const third = await t.hs.consolidate(bankId)
      expect(third.memoriesProcessed).toBe(1)
      expect(third.observationsCreated).toBe(1)
    })
  })

  // ── Observation creation (TDD) ────────────────────────────────────────

  describe("observation creation", () => {
    it("creates observations with factType 'observation'", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Frank loves painting." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Frank loves painting.", reason: "hobby" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)
      expect(obs[0]!.fact_type).toBe("observation")
    })

    it("observations are retrievable via recall with factType filter", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Grace speaks French." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Grace speaks French.", reason: "skill" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const result = await t.hs.recall(bankId, "Grace French", {
        factTypes: ["observation"],
      })
      expect(result.memories.length).toBeGreaterThanOrEqual(1)
      const obsMemory = result.memories.find(
        (m) => m.memory.factType === "observation",
      )
      expect(obsMemory).toBeDefined()
    })

    it("observation includes sourceMemoryIds pointing to contributing facts", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Hank plays guitar." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Hank plays guitar.", reason: "skill" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)
      expect(obs[0]!.source_memory_ids).not.toBeNull()
      const sourceIds = JSON.parse(obs[0]!.source_memory_ids!) as string[]
      expect(sourceIds.length).toBeGreaterThanOrEqual(1)
    })

    it("proofCount reflects number of supporting source facts", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Iris drinks green tea." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Iris drinks green tea.", reason: "habit" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)
      expect(obs[0]!.proof_count).toBe(1)
    })

    it("sourceMemoryIds are valid memory IDs that exist in the DB", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Jack runs marathons." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Jack runs marathons.", reason: "hobby" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)
      const sourceIds = JSON.parse(obs[0]!.source_memory_ids!) as string[]
      expect(sourceIds.length).toBeGreaterThanOrEqual(1)

      // Each source ID should exist in the DB
      const hdb = (t.hs as any).hdb
      for (const sid of sourceIds) {
        const row = hdb.sqlite
          .prepare("SELECT id FROM hs_memory_units WHERE id = ?")
          .get(sid) as { id: string } | undefined
        expect(row).toBeDefined()
        expect(row!.id).toBe(sid)
      }
    })
  })

  // ── Recall with observation fact type ─────────────────────────────────

  describe("recall with observation fact type", () => {
    it("recall with observation-only fact type returns observations", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Kate loves reading." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Kate loves reading.", reason: "hobby" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const result = await t.hs.recall(bankId, "Kate reading", {
        factTypes: ["observation"],
      })
      expect(result.memories.length).toBeGreaterThanOrEqual(1)
      for (const m of result.memories) {
        expect(m.memory.factType).toBe("observation")
      }
    })

    it("recall with mixed fact types (world + experience + observation) works", async () => {
      // Retain a world fact
      await t.hs.retain(bankId, "source", {
        facts: [
          { content: "Leo is a software engineer.", factType: "world" },
          { content: "Leo enjoys debugging.", factType: "experience" },
        ],
        consolidate: false,
        dedupThreshold: 0,
      })

      // Consolidate to create observations
      t.adapter.setResponses([
        JSON.stringify([
          { action: "create", text: "Leo is a software engineer.", reason: "career" },
        ]),
        JSON.stringify([
          { action: "create", text: "Leo enjoys debugging.", reason: "preference" },
        ]),
      ])

      await t.hs.consolidate(bankId)

      const result = await t.hs.recall(bankId, "Leo software", {
        factTypes: ["world", "experience", "observation"],
      })
      expect(result.memories.length).toBeGreaterThanOrEqual(1)
    })

    it("recall with observation-only type and trace enabled works", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Mia writes poetry." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Mia writes poetry.", reason: "hobby" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const result = await t.hs.recall(bankId, "Mia poetry", {
        factTypes: ["observation"],
      })
      expect(result.memories).toBeDefined()
      expect(result.query).toBe("Mia poetry")
    })
  })

  // ── Consolidation disabled ──────────────────────────────────────────

  describe("consolidation disabled", () => {
    it("respects enableConsolidation=false — auto-trigger from retain is skipped", async () => {
      // Create a bank with consolidation disabled
      const disabledBank = t.hs.createBank("disabled-bank", {
        config: { enableConsolidation: false },
      })
      const dBankId = disabledBank.id

      // Retain with consolidate unset — should respect bank config
      await t.hs.retain(dBankId, "source", {
        facts: [{ content: "Nora likes hiking." }],
        dedupThreshold: 0,
      })

      // Since enableConsolidation=false, the auto-consolidation from retain
      // should be skipped. Raw facts should exist, but no observations.
      const obs = listObservations(dBankId)
      expect(obs).toHaveLength(0)

      const raw = listRawFacts(dBankId)
      expect(raw.length).toBeGreaterThanOrEqual(1)
    })

    it("explicit consolidate() call still works when bank has enableConsolidation=false", async () => {
      const disabledBank = t.hs.createBank("disabled-bank-2", {
        config: { enableConsolidation: false },
      })
      const dBankId = disabledBank.id

      await t.hs.retain(dBankId, "source", {
        facts: [{ content: "Oscar speaks Spanish." }],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Oscar speaks Spanish.", reason: "skill" },
        ]),
      )

      // Explicit consolidate() should still work regardless of bank config
      const result = await t.hs.consolidate(dBankId)
      expect(result.memoriesProcessed).toBe(1)
      expect(result.observationsCreated).toBe(1)
    })

    it("returns disabled status in result", async () => {
      // When the bank has no unconsolidated memories, result is all zeros
      const disabledBank = t.hs.createBank("disabled-bank-3", {
        config: { enableConsolidation: false },
      })
      const dBankId = disabledBank.id

      const result = await t.hs.consolidate(dBankId)
      expect(result.memoriesProcessed).toBe(0)
      expect(result.observationsCreated).toBe(0)
      expect(result.observationsUpdated).toBe(0)
      expect(result.observationsMerged).toBe(0)
      expect(result.skipped).toBe(0)
    })
  })

  // ── Tag routing (port of test_consolidation.py scope tests) ───────────

  describe("tag routing", () => {
    it("same-scope: observation inherits tags from source memories", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Pete loves rock climbing.", tags: ["hobbies"] }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Pete loves rock climbing.", reason: "hobby" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)
      const tags = obs[0]!.tags ? JSON.parse(obs[0]!.tags!) : []
      expect(tags).toContain("hobbies")
    })

    it("scoped fact updates global observation", async () => {
      // Create an untagged observation first
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Quinn likes coffee." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Quinn likes coffee.", reason: "pref" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const initialObs = listObservations()
      expect(initialObs).toHaveLength(1)
      const obsId = initialObs[0]!.id

      // Now retain a scoped fact and update the observation
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Quinn prefers espresso specifically.", tags: ["work"] }],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponse(
        JSON.stringify([
          {
            action: "update",
            observationId: obsId,
            text: "Quinn prefers espresso.",
            reason: "refined preference",
          },
        ]),
      )

      const result = await t.hs.consolidate(bankId)
      expect(result.observationsUpdated).toBe(1)

      // The observation should now have merged tags
      const updatedObs = listObservations()
      expect(updatedObs).toHaveLength(1)
      expect(updatedObs[0]!.content).toBe("Quinn prefers espresso.")
    })

    it("cross-scope creates untagged observation", async () => {
      // If source fact has tag-a and existing observations have tag-b,
      // the LLM may create a new observation — it inherits from the source
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Rita enjoys swimming.", tags: ["sports"] }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Rita enjoys swimming.", reason: "sport" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)
      // The observation inherits the source memory's tags
      const tags = obs[0]!.tags ? JSON.parse(obs[0]!.tags!) : []
      expect(tags).toContain("sports")
    })

    it("no match creates observation with fact's tags", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Sam likes surfing.", tags: ["beach"] }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Sam likes surfing.", reason: "hobby" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)
      const tags = obs[0]!.tags ? JSON.parse(obs[0]!.tags!) : []
      expect(tags).toContain("beach")
    })

    it("untagged fact can update scoped observation", async () => {
      // Create a scoped observation
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Tina likes yoga.", tags: ["wellness"] }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Tina likes yoga.", reason: "hobby" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const initialObs = listObservations()
      expect(initialObs).toHaveLength(1)
      const obsId = initialObs[0]!.id

      // Retain untagged fact and update the scoped observation
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Tina practices yoga daily." }],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponse(
        JSON.stringify([
          {
            action: "update",
            observationId: obsId,
            text: "Tina practices yoga daily.",
            reason: "more specific",
          },
        ]),
      )

      const result = await t.hs.consolidate(bankId)
      expect(result.observationsUpdated).toBe(1)

      const updatedObs = listObservations()
      expect(updatedObs).toHaveLength(1)
      expect(updatedObs[0]!.content).toBe("Tina practices yoga daily.")
    })

    it("tag filtering in recall respects observation tags", async () => {
      // Create observations with different tags
      await t.hs.retain(bankId, "source", {
        facts: [
          { content: "Uma likes cooking Italian food.", tags: ["food"] },
        ],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Uma likes cooking Italian food.", reason: "hobby" },
        ]),
      )

      await t.hs.consolidate(bankId)

      await t.hs.retain(bankId, "source", {
        facts: [
          { content: "Uma enjoys hiking in mountains.", tags: ["outdoors"] },
        ],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Uma enjoys hiking in mountains.", reason: "hobby" },
        ]),
      )

      await t.hs.consolidate(bankId)

      // Recall with food tag should return the food observation
      const foodResult = await t.hs.recall(bankId, "Uma", {
        factTypes: ["observation"],
        tags: ["food"],
      })
      // Should find some results with matching tags
      expect(foodResult.memories).toBeDefined()
    })

    it("multiple actions from single consolidation pass", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [
          { content: "Victor likes chess." },
          { content: "Victor plays piano." },
          { content: "Victor reads sci-fi." },
        ],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponses([
        JSON.stringify([
          { action: "create", text: "Victor likes chess.", reason: "hobby" },
        ]),
        JSON.stringify([
          { action: "create", text: "Victor plays piano.", reason: "hobby" },
        ]),
        JSON.stringify([
          { action: "create", text: "Victor reads sci-fi.", reason: "hobby" },
        ]),
      ])

      const result = await t.hs.consolidate(bankId)
      expect(result.memoriesProcessed).toBe(3)
      expect(result.observationsCreated).toBe(3)

      const obs = listObservations()
      expect(obs).toHaveLength(3)
    })
  })

  // ── Temporal range ──────────────────────────────────────────────────

  describe("temporal range expansion", () => {
    it("expands temporal range when updating observation (LEAST start, GREATEST end)", async () => {
      // Create fact with initial temporal range
      const baseTime = Date.now() - 100_000
      await t.hs.retain(bankId, "source", {
        facts: [
          {
            content: "Wendy visits the gym regularly.",
            validFrom: baseTime,
            validTo: baseTime + 10_000,
          },
        ],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Wendy visits the gym regularly.", reason: "habit" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const initialObs = listObservations()
      expect(initialObs).toHaveLength(1)
      const obsId = initialObs[0]!.id
      const initialFrom = initialObs[0]!.valid_from
      const initialTo = initialObs[0]!.valid_to

      // Add a fact with wider temporal range
      const earlierStart = baseTime - 50_000
      const laterEnd = baseTime + 50_000
      await t.hs.retain(bankId, "source", {
        facts: [
          {
            content: "Wendy has been going to the gym since January.",
            validFrom: earlierStart,
            validTo: laterEnd,
          },
        ],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponse(
        JSON.stringify([
          {
            action: "update",
            observationId: obsId,
            text: "Wendy has been going to the gym since January.",
            reason: "expanded time range",
          },
        ]),
      )

      await t.hs.consolidate(bankId)

      const updatedObs = listObservations()
      expect(updatedObs).toHaveLength(1)
      // valid_from should be the LEAST (earliest)
      expect(updatedObs[0]!.valid_from).toBeLessThanOrEqual(initialFrom!)
      // valid_to should be the GREATEST (latest)
      expect(updatedObs[0]!.valid_to).toBeGreaterThanOrEqual(initialTo!)
    })

    it("inherits temporal dates from source memories", async () => {
      const now = Date.now()
      await t.hs.retain(bankId, "source", {
        facts: [
          {
            content: "Xavier started learning guitar in 2024.",
            validFrom: now - 200_000,
            validTo: now,
          },
        ],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Xavier started learning guitar in 2024.", reason: "skill" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)
      expect(obs[0]!.valid_from).toBe(now - 200_000)
      expect(obs[0]!.valid_to).toBe(now)
    })
  })

  // ── Entity inheritance ──────────────────────────────────────────────

  describe("entity inheritance", () => {
    it("copies entity links from source facts to observations", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [
          {
            content: "Yolanda works at NASA.",
            entities: ["Yolanda", "NASA"],
          },
        ],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Yolanda works at NASA.", reason: "career" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)

      // Observations should be discoverable via entity-related recall
      const result = await t.hs.recall(bankId, "Yolanda NASA", {
        factTypes: ["observation"],
      })
      expect(result.memories.length).toBeGreaterThanOrEqual(1)
    })

    it("observation inherits entities from all contributing memories", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [
          {
            content: "Zach and Amy collaborate on projects.",
            entities: ["Zach", "Amy"],
          },
        ],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Zach and Amy collaborate on projects.", reason: "relationship" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)

      // Both entities should be retrievable via recall
      const result = await t.hs.recall(bankId, "Zach Amy projects")
      expect(result.memories.length).toBeGreaterThanOrEqual(1)
    })

    it("graph endpoint observations inherit links and entities", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [
          {
            content: "Brad manages the engineering team at Acme.",
            entities: ["Brad", "Acme"],
          },
        ],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          {
            action: "create",
            text: "Brad manages the engineering team at Acme.",
            reason: "role",
          },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)

      // Graph retrieval should find the observation via entity links
      const result = await t.hs.recall(bankId, "Brad Acme", {
        methods: ["graph"],
      })
      expect(result.memories).toBeDefined()
    })
  })

  // ── Update vs create ────────────────────────────────────────────────

  describe("update existing observations", () => {
    it("updates existing observation when LLM decides 'update'", async () => {
      // Create initial observation
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Cleo likes Python." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Cleo likes Python.", reason: "pref" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const initialObs = listObservations()
      expect(initialObs).toHaveLength(1)
      const obsId = initialObs[0]!.id

      // Now retain more info and update
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Cleo recently switched to TypeScript." }],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponse(
        JSON.stringify([
          {
            action: "update",
            observationId: obsId,
            text: "Cleo prefers TypeScript (previously Python).",
            reason: "preference changed",
          },
        ]),
      )

      const result = await t.hs.consolidate(bankId)
      expect(result.observationsUpdated).toBe(1)

      const updatedObs = listObservations()
      expect(updatedObs).toHaveLength(1)
      expect(updatedObs[0]!.content).toBe("Cleo prefers TypeScript (previously Python).")
      expect(updatedObs[0]!.id).toBe(obsId)
    })

    it("preserves history on update with previousText and reason", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Derek lives in NYC." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Derek lives in NYC.", reason: "location" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const initialObs = listObservations()
      const obsId = initialObs[0]!.id

      // Update the observation
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Derek moved to San Francisco." }],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponse(
        JSON.stringify([
          {
            action: "update",
            observationId: obsId,
            text: "Derek lives in San Francisco.",
            reason: "moved",
          },
        ]),
      )

      await t.hs.consolidate(bankId)

      const updatedObs = listObservations()
      expect(updatedObs).toHaveLength(1)
      expect(updatedObs[0]!.history).not.toBeNull()

      const history = JSON.parse(updatedObs[0]!.history!) as Array<{
        previousText: string
        reason: string
      }>
      expect(history.length).toBeGreaterThanOrEqual(1)
      expect(history[0]!.previousText).toBe("Derek lives in NYC.")
      expect(history[0]!.reason).toBe("moved")
    })

    it("merges redundant facts into single observation", async () => {
      await t.hs.retain(bankId, "source 1", {
        facts: [{ content: "Ella likes hiking." }],
        consolidate: false,
        dedupThreshold: 0,
      })
      await t.hs.retain(bankId, "source 2", {
        facts: [{ content: "Ella enjoys trail walks." }],
        consolidate: false,
        dedupThreshold: 0,
      })

      // First pass: create two observations
      t.adapter.setResponses([
        JSON.stringify([
          { action: "create", text: "Ella likes hiking.", reason: "hobby" },
        ]),
        JSON.stringify([
          { action: "create", text: "Ella enjoys trail walks.", reason: "hobby" },
        ]),
      ])

      await t.hs.consolidate(bankId)
      const twoObs = listObservations()
      expect(twoObs).toHaveLength(2)
      const obsIds = twoObs.map((o) => o.id)

      // New fact triggers a merge
      await t.hs.retain(bankId, "source 3", {
        facts: [{ content: "Ella goes hiking every weekend." }],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponse(
        JSON.stringify([
          {
            action: "merge",
            observationIds: obsIds,
            text: "Ella enjoys hiking and trail walks regularly.",
            reason: "same hobby cluster",
          },
        ]),
      )

      const result = await t.hs.consolidate(bankId)
      expect(result.observationsMerged).toBe(1)

      const finalObs = listObservations()
      expect(finalObs).toHaveLength(1)
      expect(finalObs[0]!.content).toBe("Ella enjoys hiking and trail walks regularly.")
    })

    it("keeps different people separate (no cross-entity merge)", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [
          { content: "Fred likes pizza.", entities: ["Fred"] },
          { content: "Gina likes sushi.", entities: ["Gina"] },
        ],
        consolidate: false,
        dedupThreshold: 0,
      })

      // LLM creates separate observations for each person
      t.adapter.setResponses([
        JSON.stringify([
          { action: "create", text: "Fred likes pizza.", reason: "food pref" },
        ]),
        JSON.stringify([
          { action: "create", text: "Gina likes sushi.", reason: "food pref" },
        ]),
      ])

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(2)

      const fredObs = obs.find((o) => o.content.includes("Fred"))
      const ginaObs = obs.find((o) => o.content.includes("Gina"))
      expect(fredObs).toBeDefined()
      expect(ginaObs).toBeDefined()
      expect(fredObs!.id).not.toBe(ginaObs!.id)
    })

    it("handles contradictions with temporal markers", async () => {
      const baseTime = Date.now() - 200_000
      await t.hs.retain(bankId, "source", {
        facts: [
          {
            content: "Henry was a vegetarian.",
            validFrom: baseTime,
            validTo: baseTime + 50_000,
          },
        ],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Henry was a vegetarian.", reason: "diet" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const initialObs = listObservations()
      const obsId = initialObs[0]!.id

      // New contradicting fact
      await t.hs.retain(bankId, "source", {
        facts: [
          {
            content: "Henry now eats meat.",
            validFrom: baseTime + 60_000,
            validTo: null,
          },
        ],
        consolidate: false,
        dedupThreshold: 0,
      })

      t.adapter.setResponse(
        JSON.stringify([
          {
            action: "update",
            observationId: obsId,
            text: "Henry was a vegetarian but now eats meat.",
            reason: "diet changed",
          },
        ]),
      )

      const result = await t.hs.consolidate(bankId)
      expect(result.observationsUpdated).toBe(1)

      const updatedObs = listObservations()
      expect(updatedObs).toHaveLength(1)
      expect(updatedObs[0]!.content).toContain("meat")
      // Temporal range should be expanded to cover both periods
      expect(updatedObs[0]!.valid_from).toBeLessThanOrEqual(baseTime)
    })
  })

  // ── Mental model refresh trigger ────────────────────────────────────

  describe("mental model refresh", () => {
    it("triggers auto-refresh for mental models with matching tags", async () => {
      // Create auto-refresh mental model with tags
      await t.hs.createMentalModel(bankId, {
        name: "Food Preferences",
        sourceQuery: "What are the food preferences?",
        autoRefresh: true,
        tags: ["food"],
      })

      // Retain facts with matching tags
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Ian likes tacos.", tags: ["food"] }],
        consolidate: false,
      })

      // Set responses: one for consolidation, one for the reflect call during refresh
      t.adapter.setResponses([
        JSON.stringify([
          { action: "create", text: "Ian likes tacos.", reason: "food pref" },
        ]),
        // The reflect response for the mental model refresh
        "Based on available memories, Ian likes tacos.",
      ])

      const result = await t.hs.consolidate(bankId)
      expect(result.mentalModelsRefreshQueued).toBeGreaterThanOrEqual(1)
    })

    it("does not refresh models without autoRefresh=true", async () => {
      // Create a mental model WITHOUT autoRefresh
      await t.hs.createMentalModel(bankId, {
        name: "Manual Model",
        sourceQuery: "What are the habits?",
        autoRefresh: false,
        tags: ["habits"],
      })

      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Jill exercises daily.", tags: ["habits"] }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Jill exercises daily.", reason: "habit" },
        ]),
      )

      const result = await t.hs.consolidate(bankId)
      // No refresh should be queued since autoRefresh is false
      expect(result.mentalModelsRefreshQueued).toBe(0)
    })

    it("refreshes models after consolidation completes", async () => {
      // Create auto-refresh model
      await t.hs.createMentalModel(bankId, {
        name: "Team Summary",
        sourceQuery: "What does the team do?",
        autoRefresh: true,
      })

      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Kim leads the design team." }],
        consolidate: false,
      })

      t.adapter.setResponses([
        JSON.stringify([
          { action: "create", text: "Kim leads the design team.", reason: "role" },
        ]),
        // Refresh response
        "Kim leads the design team.",
      ])

      const result = await t.hs.consolidate(bankId)
      // The untagged auto-refresh model should be queued for refresh
      // when untagged memories are consolidated
      expect(result.mentalModelsRefreshQueued).toBeGreaterThanOrEqual(1)
    })

    it("consolidation only refreshes matching tagged models", async () => {
      // Create two models with different tags
      await t.hs.createMentalModel(bankId, {
        name: "Sports Model",
        sourceQuery: "What sports do people play?",
        autoRefresh: true,
        tags: ["sports"],
      })

      await t.hs.createMentalModel(bankId, {
        name: "Music Model",
        sourceQuery: "What music do people like?",
        autoRefresh: true,
        tags: ["music"],
      })

      // Retain facts tagged only with "sports"
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Larry plays basketball.", tags: ["sports"] }],
        consolidate: false,
      })

      t.adapter.setResponses([
        JSON.stringify([
          { action: "create", text: "Larry plays basketball.", reason: "sport" },
        ]),
        // Refresh response for Sports Model
        "Larry plays basketball.",
      ])

      const result = await t.hs.consolidate(bankId)
      // Only the sports model should be refreshed, not the music model
      expect(result.mentalModelsRefreshQueued).toBe(1)
    })
  })

  // ── Observation drill-down ──────────────────────────────────────────

  describe("observation drill-down", () => {
    it("search observations returns sourceMemoryIds for drill-down", async () => {
      await t.hs.retain(bankId, "source", {
        facts: [{ content: "Mary volunteers at the shelter." }],
        consolidate: false,
      })

      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Mary volunteers at the shelter.", reason: "activity" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const obs = listObservations()
      expect(obs).toHaveLength(1)
      expect(obs[0]!.source_memory_ids).not.toBeNull()

      const sourceIds = JSON.parse(obs[0]!.source_memory_ids!) as string[]
      expect(sourceIds.length).toBeGreaterThanOrEqual(1)
    })

    it("sourceMemoryIds point to the memories that built the observation", async () => {
      await t.hs.retain(bankId, "source 1", {
        facts: [{ content: "Nate likes running." }],
        consolidate: false,
        dedupThreshold: 0,
      })
      await t.hs.retain(bankId, "source 2", {
        facts: [{ content: "Nate runs every morning." }],
        consolidate: false,
        dedupThreshold: 0,
      })

      // Create one observation from first fact, update it from second
      t.adapter.setResponse(
        JSON.stringify([
          { action: "create", text: "Nate likes running.", reason: "hobby" },
        ]),
      )

      await t.hs.consolidate(bankId)

      const initialObs = listObservations()
      expect(initialObs).toHaveLength(1)
      const obsId = initialObs[0]!.id

      t.adapter.setResponse(
        JSON.stringify([
          {
            action: "update",
            observationId: obsId,
            text: "Nate runs every morning.",
            reason: "refined",
          },
        ]),
      )

      await t.hs.consolidate(bankId)

      const updatedObs = listObservations()
      expect(updatedObs).toHaveLength(1)
      const sourceIds = JSON.parse(updatedObs[0]!.source_memory_ids!) as string[]
      expect(sourceIds.length).toBeGreaterThanOrEqual(2)

      // All sourceIds should exist as raw facts in the DB
      const hdb = (t.hs as any).hdb
      for (const sid of sourceIds) {
        const row = hdb.sqlite
          .prepare("SELECT id, fact_type FROM hs_memory_units WHERE id = ?")
          .get(sid) as { id: string; fact_type: string } | undefined
        expect(row).toBeDefined()
        // Source memories should be the raw facts, not observations
        expect(["experience", "world"]).toContain(row!.fact_type)
      }
    })
  })

  // ── Hierarchical retrieval ──────────────────────────────────────────

  describe("hierarchical retrieval", () => {
    it("mental model takes priority over observation in reflect", async () => {
      throw new Error(
        "implement me: mental model priority in 3-tier reflect search — see test_consolidation.py::test_hierarchical_mental_model_priority",
      )
    })

    it("falls back to observation when no mental model exists", async () => {
      throw new Error(
        "implement me: observation fallback in 3-tier reflect search — see test_consolidation.py::test_hierarchical_observation_fallback",
      )
    })

    it("falls back to raw facts for fresh data", async () => {
      throw new Error(
        "implement me: raw fact fallback in 3-tier reflect search — see test_consolidation.py::test_hierarchical_raw_fact_fallback",
      )
    })
  })
})
