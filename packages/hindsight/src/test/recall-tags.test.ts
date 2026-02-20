/**
 * Tests for tag-based filtering in recall.
 *
 * Port of test_tags_visibility.py.
 * Integration tests — tests matchesTags + recall with tag filters.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { matchesTags } from "../recall"
import {
  createTestHindsight,
  createRealTestHindsight,
  createTestBank,
  describeWithLLM,
  type TestHindsight,
  type RealTestHindsight,
} from "./setup"

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

describeWithLLM("reflect with tags (real LLM parity)", () => {
  let t: RealTestHindsight
  let bankId: string

  beforeEach(() => {
    t = createRealTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  it("reflect with tags only uses matching memories", async () => {
    const userAToken = "USER_A_ONLY_TOKEN_7f2a1c"
    const userBToken = "USER_B_ONLY_TOKEN_9d3e4b"

    await t.hs.retain(bankId, "test", {
      facts: [{ content: `User A private token is ${userAToken}` }],
      tags: ["user-a"],
      consolidate: false,
    })
    await t.hs.retain(bankId, "test", {
      facts: [{ content: `User B private token is ${userBToken}` }],
      tags: ["user-b"],
      consolidate: false,
    })

    const result = await t.hs.reflect(
      bankId,
      "What is user A's private token? Return only the exact token.",
      {
        tags: ["user-a"],
        tagsMatch: "any_strict",
        saveObservations: false,
        budget: "high",
        context: "Use memory tools and return only the exact token string.",
      },
    )

    expect(result.answer).toContain(userAToken)
    expect(result.answer).not.toContain(userBToken)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// list tags (integration)
// ════════════════════════════════════════════════════════════════════════════

describe("list tags", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  it("returns all unique tags with counts", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice graduated from MIT with honors in computer science" }],
      tags: ["alpha"],
      consolidate: false,
      dedupThreshold: 0,
    })
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Bob prefers hiking in the Rocky Mountains on weekends" }],
      tags: ["alpha"],
      consolidate: false,
      dedupThreshold: 0,
    })
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Charlie runs a bakery in downtown Portland" }],
      tags: ["beta"],
      consolidate: false,
      dedupThreshold: 0,
    })

    const result = t.hs.listTags(bankId)

    expect(result.items).toHaveLength(2)
    const alphaItem = result.items.find((i) => i.tag === "alpha")
    const betaItem = result.items.find((i) => i.tag === "beta")
    expect(alphaItem).toBeDefined()
    expect(alphaItem!.count).toBe(2)
    expect(betaItem).toBeDefined()
    expect(betaItem!.count).toBe(1)
    expect(result.total).toBe(2)
  })

  it("filters with wildcard prefix (user:*)", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice data" }],
      tags: ["user:alice"],
      consolidate: false,
    })
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Bob data" }],
      tags: ["user:bob"],
      consolidate: false,
    })
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Admin data" }],
      tags: ["admin:root"],
      consolidate: false,
    })

    const result = t.hs.listTags(bankId, { pattern: "user:*" })

    expect(result.items).toHaveLength(2)
    expect(result.items.every((i) => i.tag.startsWith("user:"))).toBe(true)
    expect(result.total).toBe(2)
  })

  it("filters with wildcard suffix (*-admin)", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Super admin data" }],
      tags: ["super-admin"],
      consolidate: false,
    })
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "DB admin data" }],
      tags: ["db-admin"],
      consolidate: false,
    })
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "User data" }],
      tags: ["user"],
      consolidate: false,
    })

    const result = t.hs.listTags(bankId, { pattern: "*-admin" })

    expect(result.items).toHaveLength(2)
    expect(result.items.every((i) => i.tag.endsWith("-admin"))).toBe(true)
    expect(result.total).toBe(2)
  })

  it("filters with wildcard middle (env*-prod)", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Staging prod" }],
      tags: ["env-staging-prod"],
      consolidate: false,
    })
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Direct prod" }],
      tags: ["env-prod"],
      consolidate: false,
    })
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Dev env" }],
      tags: ["env-dev"],
      consolidate: false,
    })

    const result = t.hs.listTags(bankId, { pattern: "env*-prod" })

    // Should match env-staging-prod and env-prod, but not env-dev
    expect(result.items).toHaveLength(2)
    const tags = result.items.map((i) => i.tag)
    expect(tags).toContain("env-staging-prod")
    expect(tags).toContain("env-prod")
    expect(tags).not.toContain("env-dev")
  })

  it("wildcard matching is case-insensitive", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice data" }],
      tags: ["User:Alice"],
      consolidate: false,
    })

    const result = t.hs.listTags(bankId, { pattern: "user:*" })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.tag).toBe("User:Alice")
  })

  it("supports pagination with limit and offset", async () => {
    // Seed 5 distinct tags with very different content to avoid dedup
    const tagContent: Record<string, string> = {
      alpha: "Alice graduated from MIT with a degree in computer science",
      bravo: "Bob prefers hiking in the Rocky Mountains on weekends",
      charlie: "Charlie runs a bakery in downtown Portland specializing in sourdough",
      delta: "Diana works as a marine biologist studying coral reef ecosystems",
      echo: "Edward teaches classical piano at the Vienna conservatory",
    }
    for (const [tag, content] of Object.entries(tagContent)) {
      await t.hs.retain(bankId, "test", {
        facts: [{ content }],
        tags: [tag],
        consolidate: false,
        dedupThreshold: 0,
      })
    }

    const page1 = t.hs.listTags(bankId, { limit: 2, offset: 0 })
    const page2 = t.hs.listTags(bankId, { limit: 2, offset: 2 })
    const page3 = t.hs.listTags(bankId, { limit: 2, offset: 4 })

    expect(page1.items).toHaveLength(2)
    expect(page2.items).toHaveLength(2)
    expect(page3.items).toHaveLength(1)
    expect(page1.total).toBe(5)
    expect(page2.total).toBe(5)

    // No overlap between pages
    const page1Tags = page1.items.map((i) => i.tag)
    const page2Tags = page2.items.map((i) => i.tag)
    for (const tag of page1Tags) {
      expect(page2Tags).not.toContain(tag)
    }
  })

  it("returns empty for bank with no tags", () => {
    const result = t.hs.listTags(bankId)

    expect(result.items).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.limit).toBe(100)
    expect(result.offset).toBe(0)
  })

  it("returns tags ordered by count descending", async () => {
    // tag-a: 3 memories, tag-c: 2 memories, tag-b: 1 memory
    const tagAContents = [
      "Alice graduated from MIT with honors in computer science",
      "Bob prefers hiking in the Rocky Mountains on weekends",
      "Charlie runs a bakery in downtown Portland specializing in sourdough",
    ]
    for (const content of tagAContents) {
      await t.hs.retain(bankId, "test", {
        facts: [{ content }],
        tags: ["tag-a"],
        consolidate: false,
        dedupThreshold: 0,
      })
    }
    const tagCContents = [
      "Diana works as a marine biologist studying coral reef ecosystems",
      "Edward teaches classical piano at the Vienna conservatory",
    ]
    for (const content of tagCContents) {
      await t.hs.retain(bankId, "test", {
        facts: [{ content }],
        tags: ["tag-c"],
        consolidate: false,
        dedupThreshold: 0,
      })
    }
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Frank designs electric vehicles for a startup in Detroit" }],
      tags: ["tag-b"],
      consolidate: false,
      dedupThreshold: 0,
    })

    const result = t.hs.listTags(bankId)

    expect(result.items).toHaveLength(3)
    expect(result.items[0]!.tag).toBe("tag-a")
    expect(result.items[0]!.count).toBe(3)
    expect(result.items[1]!.tag).toBe("tag-c")
    expect(result.items[1]!.count).toBe(2)
    expect(result.items[2]!.tag).toBe("tag-b")
    expect(result.items[2]!.count).toBe(1)
  })
})
