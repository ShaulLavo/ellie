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

    it("allows superset — memory with MORE tags than requested still matches", () => {
      // Memory has tag-a, tag-b, tag-c; filter requires tag-a, tag-b
      // all_strict requires all filter tags present — superset should pass
      expect(matchesTags(["tag-a", "tag-b", "tag-c"], ["tag-a", "tag-b"], "all_strict")).toBe(true)
    })
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

  it("recall with multiple tags uses OR matching", async () => {
    const result = await t.hs.recall(bankId, "project", {
      tags: ["project-alpha", "project-beta"],
      tagsMatch: "any_strict",
    })

    // Should return memories tagged with either project-alpha or project-beta
    for (const m of result.memories) {
      const tags = m.memory.tags ?? []
      const hasAlpha = tags.includes("project-alpha")
      const hasBeta = tags.includes("project-beta")
      expect(hasAlpha || hasBeta).toBe(true)
    }
  })

  it("recall returns memories with any overlapping tag (multi-tagged memory)", async () => {
    // Add a memory with multiple tags
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Cross-project sync between Alpha and Beta" }],
      tags: ["project-alpha", "project-beta"],
      consolidate: false,
    })

    const result = await t.hs.recall(bankId, "cross-project sync", {
      tags: ["project-alpha"],
      tagsMatch: "any_strict",
    })

    // The multi-tagged memory should appear since it has project-alpha
    expect(result.memories.length).toBeGreaterThan(0)
  })

  it("recall with empty tags returns all memories", async () => {
    const result = await t.hs.recall(bankId, "project", {
      tags: [],
    })
    // Empty tags = no filtering, returns all memories
    expect(result.memories.length).toBeGreaterThan(0)
  })

  // ── retain with tags ────────────────────────────────────────────────

  it("retain stores memories with tags", async () => {
    const result = await t.hs.retain(bankId, "test", {
      facts: [{ content: "Tagged fact for verification" }],
      tags: ["verified-tag"],
      consolidate: false,
      dedupThreshold: 0,
    })

    expect(result.memories[0]!.tags).toEqual(["verified-tag"])
  })

  it("retain with document_tags applies tags to all items", async () => {
    const result = await t.hs.retain(bankId, "test", {
      facts: [
        { content: "Fact A" },
        { content: "Fact B" },
      ],
      tags: ["doc-tag"],
      consolidate: false,
    })

    for (const m of result.memories) {
      expect(m.tags).toContain("doc-tag")
    }
  })

  it("retain merges document tags and item tags", async () => {
    const result = await t.hs.retain(bankId, "test", {
      facts: [
        { content: "Fact with own tags", tags: ["item-tag"] },
      ],
      tags: ["doc-tag"],
      consolidate: false,
      dedupThreshold: 0,
    })

    const tags = result.memories[0]!.tags ?? []
    expect(tags).toContain("doc-tag")
    expect(tags).toContain("item-tag")
  })

  // ── reflect with tags ───────────────────────────────────────────────

  it("reflect with tags only uses matching memories", () => {
    throw new Error(
      "implement me: requires agentic mock adapter to verify tag filtering in reflect — see test_tags_visibility.py::test_reflect_with_tags",
    )
  })

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

    it("multi-user agent visibility — user A sees own + group, not user B private", async () => {
      // Seed: user-a private, user-b private, group-shared
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "User A private data" }],
        tags: ["user-a"],
        consolidate: false,
      })
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "User B private data" }],
        tags: ["user-b"],
        consolidate: false,
      })
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "Group shared data" }],
        tags: ["user-a", "user-b", "group"],
        consolidate: false,
      })

      // User A queries with their tag — should see own + group (has user-a tag)
      const resultA = await t.hs.recall(bankId, "data", {
        tags: ["user-a"],
        tagsMatch: "any_strict",
      })

      for (const m of resultA.memories) {
        const tags = m.memory.tags ?? []
        expect(tags).toContain("user-a")
      }
    })

    it("student tracking visibility — student sees own data, teacher sees all", async () => {
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "Student Alice homework" }],
        tags: ["student-alice"],
        consolidate: false,
      })
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "Student Bob homework" }],
        tags: ["student-bob"],
        consolidate: false,
      })

      // Student Alice only sees her data
      const aliceResult = await t.hs.recall(bankId, "homework", {
        tags: ["student-alice"],
        tagsMatch: "any_strict",
      })
      for (const m of aliceResult.memories) {
        expect(m.memory.tags).toContain("student-alice")
      }

      // Teacher sees all (no tag filter = all memories visible)
      const teacherResult = await t.hs.recall(bankId, "homework")
      expect(teacherResult.memories.length).toBeGreaterThanOrEqual(2)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// list tags (integration)
// ════════════════════════════════════════════════════════════════════════════

describe("list tags", () => {
  it("returns all unique tags with counts", () => {
    throw new Error("implement me: Hindsight.listTags() not implemented — see test_tags_visibility.py::test_list_tags")
  })
  it("filters with wildcard prefix (user:*)", () => {
    throw new Error("implement me: Hindsight.listTags() not implemented — see test_tags_visibility.py::test_list_tags_wildcard_prefix")
  })
  it("filters with wildcard suffix (*-admin)", () => {
    throw new Error("implement me: Hindsight.listTags() not implemented — see test_tags_visibility.py::test_list_tags_wildcard_suffix")
  })
  it("filters with wildcard middle (env*-prod)", () => {
    throw new Error("implement me: Hindsight.listTags() not implemented — see test_tags_visibility.py::test_list_tags_wildcard_middle")
  })
  it("wildcard matching is case-insensitive", () => {
    throw new Error("implement me: Hindsight.listTags() not implemented — see test_tags_visibility.py::test_list_tags_case_insensitive")
  })
  it("supports pagination with limit and offset", () => {
    throw new Error("implement me: Hindsight.listTags() not implemented — see test_tags_visibility.py::test_list_tags_pagination")
  })
  it("returns empty for bank with no tags", () => {
    throw new Error("implement me: Hindsight.listTags() not implemented — see test_tags_visibility.py::test_list_tags_empty")
  })
  it("returns tags ordered by count descending", () => {
    throw new Error("implement me: Hindsight.listTags() not implemented — see test_tags_visibility.py::test_list_tags_ordered")
  })
})
