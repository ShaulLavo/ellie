/**
 * Tests for tag-based filtering in recall.
 *
 * Port of test_tags_visibility.py.
 * Integration tests — tests matchesTags + recall with tag filters.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { matchesTags } from "../recall"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

// ════════════════════════════════════════════════════════════════════════════
// matchesTags (unit tests)
// ════════════════════════════════════════════════════════════════════════════

describe("matchesTags", () => {
  describe("mode: any (default — most permissive)", () => {
    it("returns true for untagged memory", () => {
      expect(matchesTags([], ["tag-a"], "any")).toBe(true)
    })

    it("returns true when memory has a matching tag", () => {
      expect(matchesTags(["tag-a", "tag-b"], ["tag-a"], "any")).toBe(true)
    })

    it("returns true when memory has any of the filter tags", () => {
      expect(matchesTags(["tag-c"], ["tag-a", "tag-b", "tag-c"], "any")).toBe(true)
    })

    it("returns false when memory has no matching tags", () => {
      expect(matchesTags(["tag-x"], ["tag-a", "tag-b"], "any")).toBe(false)
    })

    it("returns true when filter is empty (no filtering)", () => {
      expect(matchesTags(["tag-a"], [], "any")).toBe(true)
    })
  })

  describe("mode: all (memory must have ALL filter tags)", () => {
    it("returns true for untagged memory", () => {
      expect(matchesTags([], ["tag-a", "tag-b"], "all")).toBe(true)
    })

    it("returns true when memory has all filter tags", () => {
      expect(matchesTags(["tag-a", "tag-b", "tag-c"], ["tag-a", "tag-b"], "all")).toBe(true)
    })

    it("returns false when memory is missing a filter tag", () => {
      expect(matchesTags(["tag-a"], ["tag-a", "tag-b"], "all")).toBe(false)
    })
  })

  describe("mode: any_strict (excludes untagged)", () => {
    it("returns false for untagged memory", () => {
      expect(matchesTags([], ["tag-a"], "any_strict")).toBe(false)
    })

    it("returns true when memory has a matching tag", () => {
      expect(matchesTags(["tag-a"], ["tag-a"], "any_strict")).toBe(true)
    })

    it("returns false when no matching tags", () => {
      expect(matchesTags(["tag-x"], ["tag-a"], "any_strict")).toBe(false)
    })
  })

  describe("mode: all_strict (excludes untagged, requires all)", () => {
    it("returns false for untagged memory", () => {
      expect(matchesTags([], ["tag-a", "tag-b"], "all_strict")).toBe(false)
    })

    it("returns true when memory has all filter tags", () => {
      expect(matchesTags(["tag-a", "tag-b"], ["tag-a", "tag-b"], "all_strict")).toBe(true)
    })

    it("returns false when missing tags", () => {
      expect(matchesTags(["tag-a"], ["tag-a", "tag-b"], "all_strict")).toBe(false)
    })

    it.todo("allows superset — memory with MORE tags than requested still matches")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// recall with tag filters (integration)
// ════════════════════════════════════════════════════════════════════════════

describe("recall with tag filtering", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(async () => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)

    // Seed memories with different tags
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Project Alpha update: shipped v2.0" }],
      tags: ["project-alpha"],
      consolidate: false,
    })
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Project Beta kickoff meeting" }],
      tags: ["project-beta"],
      consolidate: false,
    })
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "General company announcement" }],
      consolidate: false,
      // No tags → untagged
    })
  })

  afterEach(() => {
    t.cleanup()
  })

  it("returns all memories when no tag filter", async () => {
    const result = await t.hs.recall(bankId, "project update")
    // Should include all memories (no tag filter applied)
    expect(result.memories.length).toBeGreaterThan(0)
  })

  it("filters memories by tag (any mode)", async () => {
    const result = await t.hs.recall(bankId, "project", {
      tags: ["project-alpha"],
      tagsMatch: "any",
    })

    for (const m of result.memories) {
      const tags = m.memory.tags ?? []
      // In "any" mode, untagged memories are also included
      if (tags.length > 0) {
        expect(tags).toContain("project-alpha")
      }
    }
  })

  it("excludes untagged in strict mode", async () => {
    const result = await t.hs.recall(bankId, "project", {
      tags: ["project-alpha"],
      tagsMatch: "any_strict",
    })

    for (const m of result.memories) {
      const tags = m.memory.tags ?? []
      expect(tags.length).toBeGreaterThan(0)
      expect(tags).toContain("project-alpha")
    }
  })

  it.todo("recall with multiple tags uses OR matching")

  it.todo("recall returns memories with any overlapping tag (multi-tagged memory)")

  it.todo("recall with empty tags returns all memories")

  // ── retain with tags ────────────────────────────────────────────────

  it.todo("retain stores memories with tags")

  it.todo("retain with document_tags applies tags to all items")

  it.todo("retain merges document tags and item tags")

  // ── reflect with tags ───────────────────────────────────────────────

  it.todo("reflect with tags only uses matching memories")

  // ── Multi-user isolation ──────────────────────────────────────────────

  describe("multi-user isolation via tags", () => {
    it("user A only sees their tagged memories", async () => {
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "User A's private note" }],
        tags: ["user-a"],
        consolidate: false,
      })
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "User B's private note" }],
        tags: ["user-b"],
        consolidate: false,
      })

      const resultA = await t.hs.recall(bankId, "private note", {
        tags: ["user-a"],
        tagsMatch: "any_strict",
      })

      for (const m of resultA.memories) {
        expect(m.memory.tags).toContain("user-a")
        expect(m.memory.tags).not.toContain("user-b")
      }
    })

    it.todo("multi-user agent visibility — user A sees own + group, not user B private")

    it.todo("student tracking visibility — student sees own data, teacher sees all")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// list tags (integration)
// ════════════════════════════════════════════════════════════════════════════

describe("list tags", () => {
  it.todo("returns all unique tags with counts")

  it.todo("filters with wildcard prefix (user:*)")

  it.todo("filters with wildcard suffix (*-admin)")

  it.todo("filters with wildcard middle (env*-prod)")

  it.todo("wildcard matching is case-insensitive")

  it.todo("supports pagination with limit and offset")

  it.todo("returns empty for bank with no tags")

  it.todo("returns tags ordered by count descending")
})
