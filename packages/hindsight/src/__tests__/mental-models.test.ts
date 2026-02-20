/**
 * Tests for mental model management — CRUD, refresh, auto-refresh.
 *
 * Port of test_mental_models.py + test_reflections.py (mental model parts).
 * Integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Mental models", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  // ── Create ──────────────────────────────────────────────────────────────

  describe("createMentalModel", () => {
    it("creates a mental model with required fields", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "Team Preferences",
        sourceQuery: "What are the team's communication preferences?",
      })

      expect(model.id).toBeDefined()
      expect(model.name).toBe("Team Preferences")
      expect(model.sourceQuery).toBe("What are the team's communication preferences?")
      expect(model.bankId).toBe(bankId)
    })

    it("creates with initial content", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "Summary",
        sourceQuery: "Team summary",
        content: "The team prefers async communication via Slack",
      })

      expect(model.content).toBe("The team prefers async communication via Slack")
    })

    it("creates with tags", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "Tagged Model",
        sourceQuery: "query",
        tags: ["team", "communication"],
      })

      expect(model.tags).toEqual(["team", "communication"])
    })

    it("creates with autoRefresh flag", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "Auto Model",
        sourceQuery: "query",
        autoRefresh: true,
      })

      expect(model.autoRefresh).toBe(true)
    })

    it("defaults autoRefresh to false", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "Default Model",
        sourceQuery: "query",
      })

      expect(model.autoRefresh).toBe(false)
    })

    it("sets timestamps", async () => {
      const before = Date.now()
      const model = await t.hs.createMentalModel(bankId, {
        name: "Timed",
        sourceQuery: "query",
      })
      const after = Date.now()

      expect(model.createdAt).toBeGreaterThanOrEqual(before)
      expect(model.createdAt).toBeLessThanOrEqual(after)
    })
  })

  // ── Get ─────────────────────────────────────────────────────────────────

  describe("getMentalModel", () => {
    it("retrieves a mental model by ID", async () => {
      const created = await t.hs.createMentalModel(bankId, {
        name: "Findable",
        sourceQuery: "query",
      })

      const found = t.hs.getMentalModel(bankId, created.id)
      expect(found).toBeDefined()
      expect(found!.id).toBe(created.id)
      expect(found!.name).toBe("Findable")
    })

    it("returns undefined for non-existent ID", () => {
      expect(t.hs.getMentalModel(bankId, "nonexistent")).toBeUndefined()
    })

    it("returns undefined for wrong bank", async () => {
      const otherBank = createTestBank(t.hs, "other-bank")
      const model = await t.hs.createMentalModel(bankId, {
        name: "Bank-scoped",
        sourceQuery: "query",
      })

      expect(t.hs.getMentalModel(otherBank, model.id)).toBeUndefined()
    })
  })

  // ── List ────────────────────────────────────────────────────────────────

  describe("listMentalModels", () => {
    it("returns empty array when none exist", () => {
      expect(t.hs.listMentalModels(bankId)).toHaveLength(0)
    })

    it("returns all mental models for a bank", async () => {
      await t.hs.createMentalModel(bankId, { name: "M1", sourceQuery: "q1" })
      await t.hs.createMentalModel(bankId, { name: "M2", sourceQuery: "q2" })
      await t.hs.createMentalModel(bankId, { name: "M3", sourceQuery: "q3" })

      expect(t.hs.listMentalModels(bankId)).toHaveLength(3)
    })

    it.todo("filters by tags when tags option provided")

    it("is bank-scoped", async () => {
      const otherBank = createTestBank(t.hs, "other-bank")
      await t.hs.createMentalModel(bankId, { name: "Bank1Model", sourceQuery: "q" })
      await t.hs.createMentalModel(otherBank, { name: "Bank2Model", sourceQuery: "q" })

      expect(t.hs.listMentalModels(bankId)).toHaveLength(1)
      expect(t.hs.listMentalModels(otherBank)).toHaveLength(1)
    })
  })

  // ── Update ──────────────────────────────────────────────────────────────

  describe("updateMentalModel", () => {
    it("updates the name", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "Old Name",
        sourceQuery: "query",
      })

      const updated = await t.hs.updateMentalModel(bankId, model.id, {
        name: "New Name",
      })

      expect(updated.name).toBe("New Name")
    })

    it("updates the content", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "Model",
        sourceQuery: "query",
        content: "Old content",
      })

      const updated = await t.hs.updateMentalModel(bankId, model.id, {
        content: "New content",
      })

      expect(updated.content).toBe("New content")
    })

    it("updates tags", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "Model",
        sourceQuery: "query",
        tags: ["old-tag"],
      })

      const updated = await t.hs.updateMentalModel(bankId, model.id, {
        tags: ["new-tag-1", "new-tag-2"],
      })

      expect(updated.tags).toEqual(["new-tag-1", "new-tag-2"])
    })

    it("updates autoRefresh", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "Model",
        sourceQuery: "query",
        autoRefresh: false,
      })

      const updated = await t.hs.updateMentalModel(bankId, model.id, {
        autoRefresh: true,
      })

      expect(updated.autoRefresh).toBe(true)
    })

    it("updates updatedAt timestamp", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "Model",
        sourceQuery: "query",
      })

      const updated = await t.hs.updateMentalModel(bankId, model.id, {
        name: "Updated",
      })

      expect(updated.updatedAt).toBeGreaterThanOrEqual(model.createdAt)
    })
  })

  // ── Delete ──────────────────────────────────────────────────────────────

  describe("deleteMentalModel", () => {
    it("deletes a mental model", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "ToDelete",
        sourceQuery: "query",
      })

      t.hs.deleteMentalModel(bankId, model.id)
      expect(t.hs.getMentalModel(bankId, model.id)).toBeUndefined()
    })

    it("does not affect other models", async () => {
      const keep = await t.hs.createMentalModel(bankId, {
        name: "Keep",
        sourceQuery: "q1",
      })
      const remove = await t.hs.createMentalModel(bankId, {
        name: "Remove",
        sourceQuery: "q2",
      })

      t.hs.deleteMentalModel(bankId, remove.id)

      expect(t.hs.getMentalModel(bankId, keep.id)).toBeDefined()
      expect(t.hs.getMentalModel(bankId, remove.id)).toBeUndefined()
    })
  })

  // ── Refresh (TDD — calls reflect which needs agentic mock) ────────────

  describe("refreshMentalModel", () => {
    it.todo("refreshes content via reflect() and updates model content")
    it.todo("updates lastRefreshedAt timestamp after refresh")
    it.todo("refresh with tags only accesses tagged memories")
    it.todo("refresh with directives applies them to reflect prompt")
    it.todo("refresh completes without error when bank has directives")
    it.todo("refresh updates content from initial placeholder value")
  })

  // ── Mental models in reflect ──────────────────────────────────────────

  describe("mental models used in reflect", () => {
    it.todo("reflect searches mental models when they exist")
    it.todo("stale mental model triggers tier 2/3 search")
    it.todo("mental model with autoRefresh gets refreshed after consolidation")
    it.todo("consolidation only refreshes matching tagged models")
    it.todo("untagged auto-refresh models are always refreshed after any consolidation")
    it.todo("reflect based_on separates directives, memories, and mental models")
  })

  // ── Tag security boundaries ───────────────────────────────────────────

  describe("tag security", () => {
    it.todo("mental model refresh respects tag boundaries")
    it.todo("refresh with tags only accesses same tagged models")
    it.todo("refresh of tagged model does not access different-tagged models")
    it.todo("refresh of tagged model excludes untagged memories")
    it.todo("consolidation does not refresh models with non-matching tags")
  })

  // ── Custom ID (port of test_reflections.py) ──────────────────────────

  describe("custom ID", () => {
    it.todo("creates mental model with custom ID")
  })
})
