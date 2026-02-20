/**
 * Tests for directive management — CRUD, priority, tags, injection.
 *
 * Port of test_reflections.py (directive parts) + test_mental_models.py (directive parts).
 * Integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"
// Used by .todo tests below — keep for when they're implemented
import { loadDirectivesForReflect as _loadDirectivesForReflect } from "../directives"
import {
  buildDirectivesSection as _buildDirectivesSection,
  buildDirectivesReminder as _buildDirectivesReminder,
} from "../prompts"

describe("Directives", () => {
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

  describe("createDirective", () => {
    it("creates a directive with required fields", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "Be Concise",
        content: "Keep all responses under 3 sentences.",
      })

      expect(directive.id).toBeDefined()
      expect(directive.bankId).toBe(bankId)
      expect(directive.name).toBe("Be Concise")
      expect(directive.content).toBe("Keep all responses under 3 sentences.")
    })

    it("defaults priority to 0", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "Default Priority",
        content: "Test",
      })
      expect(directive.priority).toBe(0)
    })

    it("defaults isActive to true", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "Active Default",
        content: "Test",
      })
      expect(directive.isActive).toBe(true)
    })

    it("creates with custom priority", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "High Priority",
        content: "Very important rule",
        priority: 10,
      })
      expect(directive.priority).toBe(10)
    })

    it("creates as inactive", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "Inactive",
        content: "Paused rule",
        isActive: false,
      })
      expect(directive.isActive).toBe(false)
    })

    it("creates with tags", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "Tagged",
        content: "Rule for team-a",
        tags: ["team-a"],
      })
      expect(directive.tags).toEqual(["team-a"])
    })

    it("defaults tags to null", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "Untagged",
        content: "Global rule",
      })
      expect(directive.tags).toBeNull()
    })
  })

  // ── Get ─────────────────────────────────────────────────────────────────

  describe("getDirective", () => {
    it("retrieves a directive by ID", () => {
      const created = t.hs.createDirective(bankId, {
        name: "Findable",
        content: "Test",
      })

      const found = t.hs.getDirective(bankId, created.id)
      expect(found).toBeDefined()
      expect(found!.id).toBe(created.id)
      expect(found!.name).toBe("Findable")
    })

    it("returns undefined for non-existent ID", () => {
      expect(t.hs.getDirective(bankId, "nonexistent")).toBeUndefined()
    })
  })

  // ── List ────────────────────────────────────────────────────────────────

  describe("listDirectives", () => {
    it("returns empty array when none exist", () => {
      expect(t.hs.listDirectives(bankId)).toHaveLength(0)
    })

    it("returns only active directives by default", () => {
      t.hs.createDirective(bankId, { name: "Active", content: "active" })
      t.hs.createDirective(bankId, {
        name: "Inactive",
        content: "inactive",
        isActive: false,
      })

      const active = t.hs.listDirectives(bankId)
      expect(active).toHaveLength(1)
      expect(active[0]!.name).toBe("Active")
    })

    it("returns all directives when activeOnly=false", () => {
      t.hs.createDirective(bankId, { name: "Active", content: "active" })
      t.hs.createDirective(bankId, {
        name: "Inactive",
        content: "inactive",
        isActive: false,
      })

      const all = t.hs.listDirectives(bankId, false)
      expect(all).toHaveLength(2)
    })

    it("sorts by priority descending", () => {
      t.hs.createDirective(bankId, { name: "Low", content: "low", priority: 1 })
      t.hs.createDirective(bankId, { name: "High", content: "high", priority: 10 })
      t.hs.createDirective(bankId, { name: "Mid", content: "mid", priority: 5 })

      const directives = t.hs.listDirectives(bankId)
      expect(directives[0]!.name).toBe("High")
      expect(directives[1]!.name).toBe("Mid")
      expect(directives[2]!.name).toBe("Low")
    })
  })

  // ── Update ──────────────────────────────────────────────────────────────

  describe("updateDirective", () => {
    it("updates the name", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "Old",
        content: "test",
      })

      const updated = t.hs.updateDirective(bankId, directive.id, {
        name: "New",
      })
      expect(updated.name).toBe("New")
    })

    it("updates the content", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "Rule",
        content: "Old content",
      })

      const updated = t.hs.updateDirective(bankId, directive.id, {
        content: "New content",
      })
      expect(updated.content).toBe("New content")
    })

    it("updates priority", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "Rule",
        content: "test",
        priority: 0,
      })

      const updated = t.hs.updateDirective(bankId, directive.id, {
        priority: 100,
      })
      expect(updated.priority).toBe(100)
    })

    it("updates isActive", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "Rule",
        content: "test",
      })

      const updated = t.hs.updateDirective(bankId, directive.id, {
        isActive: false,
      })
      expect(updated.isActive).toBe(false)
    })

    it("updates tags", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "Rule",
        content: "test",
      })

      const updated = t.hs.updateDirective(bankId, directive.id, {
        tags: ["new-tag"],
      })
      expect(updated.tags).toEqual(["new-tag"])
    })
  })

  // ── Delete ──────────────────────────────────────────────────────────────

  describe("deleteDirective", () => {
    it("deletes a directive", () => {
      const directive = t.hs.createDirective(bankId, {
        name: "ToDelete",
        content: "test",
      })

      t.hs.deleteDirective(bankId, directive.id)
      expect(t.hs.getDirective(bankId, directive.id)).toBeUndefined()
    })
  })

  // ── Tag-based loading for reflect ────────────────────────────────────

  describe("loadDirectivesForReflect", () => {
    it.todo("returns only tagless directives when no session tags")
    it.todo("returns matching directives when session tags provided")
    it.todo("excludes tag-scoped directives from tagless session")
    it.todo("includes tagless directives in tagged session (any mode)")
  })

  // ── Directives in reflect (TDD — need agentic mock to verify prompt content) ─

  describe("directives in reflect", () => {
    it.todo("reflect includes active directives in system prompt (verified via adapter call)")
    it.todo("inactive directives are excluded from reflect system prompt")
    it.todo("reflect follows language directive (e.g., respond in Spanish)")
    it.todo("tagged directive not applied when session has no matching tags")
  })
})
