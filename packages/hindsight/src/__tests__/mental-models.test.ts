/**
 * Tests for mental model management — CRUD, refresh, auto-refresh.
 *
 * Port of test_mental_models.py + test_reflections.py (mental model parts).
 * Integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, implementMe, type TestHindsight } from "./setup"

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

    it("filters by tags when tags option provided", async () => {
      // listMentalModels currently only accepts bankId — no tag filter parameter.
      implementMe(
        "listMentalModels needs tag filter option",
        "test_mental_models.py::test_list_mental_models_with_tags",
      )
    })

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
    it("refreshes content via reflect() and updates model content", async () => {
      // Create a model with initial placeholder content
      const model = await t.hs.createMentalModel(bankId, {
        name: "Refreshable",
        sourceQuery: "What does the team prefer?",
        content: "Initial placeholder",
      })

      // The mock adapter returns text via chatStream; reflect() will produce
      // an answer from whatever the mock returns. Set a recognizable answer.
      t.adapter.setResponse("The team prefers async communication and daily standups.")

      const result = await t.hs.refreshMentalModel(bankId, model.id)

      // Content should be updated to the reflect answer
      expect(result.model.content).toBe(
        "The team prefers async communication and daily standups.",
      )
      expect(result.reflectResult).toBeDefined()
      expect(result.reflectResult.answer).toBe(
        "The team prefers async communication and daily standups.",
      )

      // Verify persistence
      const fetched = t.hs.getMentalModel(bankId, model.id)
      expect(fetched!.content).toBe(
        "The team prefers async communication and daily standups.",
      )
    })

    it("updates lastRefreshedAt timestamp after refresh", async () => {
      const model = await t.hs.createMentalModel(bankId, {
        name: "Timed Refresh",
        sourceQuery: "query",
        content: "old content",
      })

      const beforeRefresh = Date.now()

      t.adapter.setResponse("Refreshed content")
      const result = await t.hs.refreshMentalModel(bankId, model.id)

      const afterRefresh = Date.now()

      expect(result.model.lastRefreshedAt).toBeDefined()
      expect(result.model.lastRefreshedAt).not.toBeNull()
      expect(result.model.lastRefreshedAt!).toBeGreaterThanOrEqual(beforeRefresh)
      expect(result.model.lastRefreshedAt!).toBeLessThanOrEqual(afterRefresh)

      // Verify persistence via getMentalModel
      const fetched = t.hs.getMentalModel(bankId, model.id)
      expect(fetched!.lastRefreshedAt).toBe(result.model.lastRefreshedAt)
    })

    it("refresh with tags only accesses tagged memories", async () => {
      // This test requires verifying that the reflect call uses tag filtering
      // internally. The refreshMentalModel function passes model tags with
      // all_strict matching to reflect(). We can verify by checking that
      // the refresh completes and uses the tagged reflect path.
      // However, verifying that memories are actually filtered by tags
      // requires seeding tagged memories and checking which ones appear
      // in the result — which needs agentic tool calling from the mock.
      implementMe(
        "refresh with tags needs agentic mock to verify tag-filtered recall",
        "test_mental_models.py::test_refresh_with_tags",
      )
    })

    it("refresh with directives applies them to reflect prompt", async () => {
      // Verifying that directives are injected into the reflect prompt
      // requires inspecting the system prompt passed to the adapter.
      // The current mock adapter tracks calls but doesn't expose the
      // system prompt in a structured way for assertion.
      implementMe(
        "refresh with directives needs adapter call inspection for system prompt",
        "test_mental_models.py::test_refresh_with_directives",
      )
    })

    it("refresh completes without error when bank has directives", async () => {
      // Create a directive in the bank
      t.hs.createDirective(bankId, {
        name: "Be precise",
        content: "Always provide precise information with sources.",
      })

      // Create a mental model
      const model = await t.hs.createMentalModel(bankId, {
        name: "Directive Model",
        sourceQuery: "What are the key facts?",
        content: "Placeholder",
      })

      // Set a mock response for the reflect call
      t.adapter.setResponse("Precise refreshed content with sources.")

      // Should complete without error — directives are loaded and injected
      const result = await t.hs.refreshMentalModel(bankId, model.id)

      expect(result.model.content).toBe("Precise refreshed content with sources.")
      expect(result.reflectResult.answer).toBeDefined()
    })

    it("refresh updates content from initial placeholder value", async () => {
      // Create model with no initial content (content is null)
      const model = await t.hs.createMentalModel(bankId, {
        name: "No Content Model",
        sourceQuery: "What do we know about the project?",
      })

      expect(model.content).toBeNull()
      expect(model.lastRefreshedAt).toBeNull()

      t.adapter.setResponse("The project uses TypeScript and Bun runtime.")

      const result = await t.hs.refreshMentalModel(bankId, model.id)

      // Content should now be set
      expect(result.model.content).toBe("The project uses TypeScript and Bun runtime.")
      expect(result.model.lastRefreshedAt).not.toBeNull()
    })
  })

  // ── Mental models in reflect ──────────────────────────────────────────

  describe("mental models used in reflect", () => {
    it("reflect searches mental models when they exist", async () => {
      // Requires agentic mock that can drive the 3-tier tool loop
      // (search_mental_models tool call). The current mock adapter
      // returns flat text and cannot simulate tool calling.
      implementMe(
        "reflect needs agentic mock to drive search_mental_models tool",
        "test_mental_models.py::test_reflect_searches_mental_models",
      )
    })

    it("stale mental model triggers tier 2/3 search", async () => {
      // Requires agentic mock that recognizes isStale=true on a mental model
      // result and then calls search_observations or search_memories.
      implementMe(
        "stale mental model drill-down needs agentic mock with multi-tool calls",
        "test_mental_models.py::test_stale_mental_model_triggers_tier2_3",
      )
    })

    it("mental model with autoRefresh gets refreshed after consolidation", async () => {
      // Requires agentic mock to verify that consolidation triggers
      // refreshMentalModel for autoRefresh=true models.
      implementMe(
        "auto-refresh after consolidation needs agentic mock for full pipeline",
        "test_mental_models.py::test_auto_refresh_after_consolidation",
      )
    })

    it("consolidation only refreshes matching tagged models", async () => {
      // Requires verifying that consolidation's triggerMentalModelRefreshes
      // respects tag boundaries. Needs agentic mock to drive consolidation
      // with tagged memories and verify which models get refreshed.
      implementMe(
        "tag-scoped consolidation refresh needs agentic mock for full pipeline",
        "test_mental_models.py::test_consolidation_only_refreshes_matching_tags",
      )
    })

    it("untagged auto-refresh models are always refreshed after any consolidation", async () => {
      // Requires agentic mock to drive consolidation and verify that
      // untagged auto-refresh models are refreshed regardless of which
      // tagged memories were consolidated.
      implementMe(
        "untagged auto-refresh after consolidation needs agentic mock",
        "test_mental_models.py::test_untagged_auto_refresh_always_refreshed",
      )
    })

    it("reflect based_on separates directives, memories, and mental models", async () => {
      // Requires agentic mock to drive reflect with mental models,
      // directives, and memories, then inspect the based_on structure.
      implementMe(
        "based_on structure needs agentic mock to collect all tiers",
        "test_reflections.py::test_reflect_based_on_separates_types",
      )
    })
  })

  // ── Tag security boundaries ───────────────────────────────────────────

  describe("tag security", () => {
    it("mental model refresh respects tag boundaries", async () => {
      // Create a tagged mental model and verify that refresh passes
      // the tags with all_strict matching to reflect. Verifying that
      // cross-tag memories are excluded requires agentic tool calling.
      implementMe(
        "tag boundary enforcement needs agentic mock to verify cross-tag exclusion",
        "test_mental_models.py::test_refresh_respects_tag_boundaries",
      )
    })

    it("refresh with tags only accesses same tagged models", async () => {
      // refreshMentalModel passes model tags to reflect with all_strict.
      // Verifying that only same-tagged memories are accessed requires
      // the agentic loop to call search tools.
      implementMe(
        "same-tag access verification needs agentic mock",
        "test_mental_models.py::test_refresh_same_tag_access",
      )
    })

    it("refresh of tagged model does not access different-tagged models", async () => {
      // Verifying cross-tag exclusion requires seeding memories with
      // different tags and checking none appear in the reflect result.
      implementMe(
        "cross-tag exclusion verification needs agentic mock",
        "test_mental_models.py::test_refresh_excludes_different_tags",
      )
    })

    it("refresh of tagged model excludes untagged memories", async () => {
      // all_strict matching in refreshMentalModel means untagged memories
      // (which have no tags) should not match. Verification requires
      // agentic mock driving the recall tool.
      implementMe(
        "untagged memory exclusion verification needs agentic mock",
        "test_mental_models.py::test_refresh_excludes_untagged_memories",
      )
    })

    it("consolidation does not refresh models with non-matching tags", async () => {
      // Verifying that triggerMentalModelRefreshes skips models whose
      // tags don't overlap with consolidated memory tags. Needs the full
      // consolidation pipeline with agentic mock.
      implementMe(
        "consolidation tag filtering needs agentic mock for full pipeline",
        "test_mental_models.py::test_consolidation_no_refresh_non_matching_tags",
      )
    })
  })

  // ── Custom ID (port of test_reflections.py) ──────────────────────────

  describe("custom ID", () => {
    it("creates mental model with custom ID", async () => {
      // CreateMentalModelOptions does not have an `id` field.
      // The id is always auto-generated via ulid() in createMentalModel.
      implementMe(
        "createMentalModel needs optional id parameter in CreateMentalModelOptions",
        "test_reflections.py::test_create_mental_model_with_custom_id",
      )
    })
  })
})
