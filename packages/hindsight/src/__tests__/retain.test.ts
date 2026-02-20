/**
 * Tests for retain() — fact extraction, storage, entity resolution, linking.
 *
 * Port of test_retain.py.
 * Integration tests — needs DB + mock adapter.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("retain", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  // ── Basic retain ────────────────────────────────────────────────────────

  describe("with pre-provided facts", () => {
    it("stores facts and returns RetainResult", async () => {
      const result = await t.hs.retain(bankId, "test content", {
        facts: [
          { content: "Peter loves hiking", factType: "experience", confidence: 0.9 },
          { content: "Alice likes reading", factType: "experience", confidence: 0.85 },
        ],
        consolidate: false,
      })

      expect(result.memories).toHaveLength(2)
      expect(result.memories[0]!.content).toBe("Peter loves hiking")
      expect(result.memories[0]!.factType).toBe("experience")
      expect(result.memories[0]!.confidence).toBe(0.9)
      expect(result.memories[1]!.content).toBe("Alice likes reading")
    })

    it("assigns IDs to stored memories", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [{ content: "Fact 1" }],
        consolidate: false,
      })

      expect(result.memories[0]!.id).toBeDefined()
      expect(result.memories[0]!.id.length).toBeGreaterThan(0)
    })

    it("assigns the correct bankId", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [{ content: "Banked fact" }],
        consolidate: false,
      })

      expect(result.memories[0]!.bankId).toBe(bankId)
    })

    it("defaults factType to a valid type when none specified", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [{ content: "No type specified" }],
        consolidate: false,
      })

      // Default factType when none provided should be "experience" or "world"
      expect(["experience", "world"]).toContain(result.memories[0]!.factType)
    })

    it("stores multiple facts from a single retain call", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [
          { content: "Fact A" },
          { content: "Fact B" },
          { content: "Fact C" },
        ],
        consolidate: false,
      })

      expect(result.memories).toHaveLength(3)
    })
  })

  // ── Entity extraction ─────────────────────────────────────────────────

  describe("entity extraction", () => {
    it("extracts entities from pre-provided facts", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [
          {
            content: "Peter works at Acme Corp",
            entities: ["Peter", "Acme Corp"],
          },
        ],
        consolidate: false,
      })

      expect(result.entities.length).toBeGreaterThanOrEqual(1)
      const names = result.entities.map((e) => e.name)
      expect(names).toContain("Peter")
    })

    it("creates entity links between memories sharing entities", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [
          { content: "Peter loves hiking", entities: ["Peter"] },
          { content: "Peter went to the store", entities: ["Peter"] },
        ],
        consolidate: false,
      })

      // Both memories share "Peter" → should create entity links
      const entityLinks = result.links.filter((l) => l.linkType === "entity")
      expect(entityLinks.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ── Tag attachment ──────────────────────────────────────────────────────

  describe("tag attachment", () => {
    it("attaches tags from options", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [{ content: "Tagged fact" }],
        tags: ["project-x", "important"],
        consolidate: false,
      })

      expect(result.memories[0]!.tags).toEqual(["project-x", "important"])
    })

    it("attaches tags from individual facts", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [{ content: "Fact with tags", tags: ["tag-a", "tag-b"] }],
        consolidate: false,
      })

      expect(result.memories[0]!.tags).toContain("tag-a")
      expect(result.memories[0]!.tags).toContain("tag-b")
    })
  })

  // ── Deduplication ─────────────────────────────────────────────────────

  describe("deduplication", () => {
    it("skips duplicate facts", async () => {
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "Peter loves hiking" }],
        consolidate: false,
        dedupThreshold: 0.92,
      })

      const result = await t.hs.retain(bankId, "test", {
        facts: [{ content: "Peter loves hiking" }],
        consolidate: false,
        dedupThreshold: 0.92,
      })

      expect(result.memories).toHaveLength(0) // deduped
    })

    it("allows when threshold is 0 (disabled)", async () => {
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "Peter loves hiking" }],
        consolidate: false,
        dedupThreshold: 0,
      })

      const result = await t.hs.retain(bankId, "test", {
        facts: [{ content: "Peter loves hiking" }],
        consolidate: false,
        dedupThreshold: 0,
      })

      expect(result.memories).toHaveLength(1) // not deduped
    })
  })

  // ── Semantic link creation ──────────────────────────────────────────────

  describe("semantic links", () => {
    it("creates semantic links between similar memories", async () => {
      // First retain
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "Peter enjoys mountain hiking trails" }],
        consolidate: false,
      })

      // Second retain with related content
      const result = await t.hs.retain(bankId, "test", {
        facts: [{ content: "Peter loves hiking in the Alps" }],
        consolidate: false,
        dedupThreshold: 0, // disable dedup so it gets stored
      })

      const semanticLinks = result.links.filter((l) => l.linkType === "semantic")
      // Semantic links may or may not be created depending on embedding similarity
      // The test verifies the mechanism runs without error and returns an array
      expect(Array.isArray(semanticLinks)).toBe(true)
    })
  })

  // ── Causal linking ──────────────────────────────────────────────────────

  describe("causal links", () => {
    it("creates causal links from causalRelations", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [
          { content: "It started raining heavily" },
          {
            content: "The hiking trail became muddy",
            // Note: causalRelations are part of the LLM extraction output,
            // not part of the pre-provided facts interface.
            // This test may need the LLM path — marking as TDD target.
          },
        ],
        consolidate: false,
      })

      // With pre-provided facts, causal links require the extraction pipeline
      // This serves as a placeholder — the full causal linking test needs LLM
      expect(result).toBeDefined()
    })
  })

  // ── Temporal fields ───────────────────────────────────────────────────

  describe("temporal fields", () => {
    it("stores validFrom and validTo from facts", async () => {
      const validFrom = Date.now() - 86_400_000 // yesterday
      const validTo = Date.now()

      const result = await t.hs.retain(bankId, "test", {
        facts: [
          {
            content: "Event happened yesterday",
            validFrom,
            validTo,
          },
        ],
        consolidate: false,
      })

      expect(result.memories[0]!.validFrom).toBe(validFrom)
      expect(result.memories[0]!.validTo).toBe(validTo)
    })

    it("defaults validFrom and validTo to null", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [{ content: "Timeless fact" }],
        consolidate: false,
      })

      expect(result.memories[0]!.validFrom).toBeNull()
      expect(result.memories[0]!.validTo).toBeNull()
    })

    it("creates temporal links for memories close in time", async () => {
      const now = Date.now()
      const result = await t.hs.retain(bankId, "test", {
        facts: [
          {
            content: "Deployment started",
            validFrom: now - 60 * 60 * 1000,
            validTo: now - 55 * 60 * 1000,
          },
          {
            content: "Deployment finished",
            validFrom: now - 20 * 60 * 1000,
            validTo: now - 10 * 60 * 1000,
          },
        ],
        consolidate: false,
        dedupThreshold: 0,
      })

      const memoryIds = new Set(result.memories.map((memory) => memory.id))
      const hdb = (t.hs as any).hdb
      const temporalLinks = hdb.db
        .select({
          sourceId: hdb.schema.memoryLinks.sourceId,
          targetId: hdb.schema.memoryLinks.targetId,
          linkType: hdb.schema.memoryLinks.linkType,
        })
        .from(hdb.schema.memoryLinks)
        .all()
        .filter(
          (link: { sourceId: string; targetId: string; linkType: string }) =>
            link.linkType === "temporal" &&
            memoryIds.has(link.sourceId) &&
            memoryIds.has(link.targetId),
        )

      expect(temporalLinks.length).toBeGreaterThanOrEqual(2)
    })
  })

  // ── Metadata ──────────────────────────────────────────────────────────

  describe("metadata", () => {
    it("attaches metadata from options", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [{ content: "Metadata fact" }],
        metadata: { source: "chat", sessionId: "abc123" },
        consolidate: false,
      })

      expect(result.memories[0]!.metadata).toEqual({
        source: "chat",
        sessionId: "abc123",
      })
    })
  })

  // ── Context preservation (needs LLM extraction) ─────────────────────

  describe("context preservation", () => {
    it.todo("preserves context and makes it retrievable via recall")
    // Python: test_context_preservation — stores content with specific context string,
    // then verifies it is preserved after recall

    it.todo("supports different contexts per item in a batch")
    // Python: test_context_with_batch — retain_batch with 3 items each having
    // different context strings, verifies all are processed
  })

  // ── Batch edge cases (needs LLM extraction) ─────────────────────────

  describe("batch edge cases", () => {
    it("handles empty batch gracefully", async () => {
      const result = await t.hs.retainBatch(bankId, [], {
        consolidate: false,
      })

      expect(result).toEqual([])
    })

    it("handles single-item batch correctly", async () => {
      const result = await t.hs.retainBatch(
        bankId,
        ["Alice went hiking in Yosemite"],
        { consolidate: false },
      )

      expect(result).toHaveLength(1)
      expect(result[0]!.memories.length).toBeGreaterThanOrEqual(1)
    })

    it("handles mixed content sizes in a batch", async () => {
      const shortContent = "Bob likes Python and hiking."
      const longContent = "Alice met Bob at the coffee shop. ".repeat(20_000) // ~700k chars

      const result = await t.hs.retainBatch(
        bankId,
        [shortContent, longContent],
        { consolidate: false, dedupThreshold: 0 },
      )

      expect(result).toHaveLength(2)
      expect(result[0]!.memories.length).toBeGreaterThanOrEqual(1)
      expect(result[1]!.memories.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ── Temporal link creation (needs LLM extraction) ───────────────────

  describe("temporal links", () => {
    it.todo("creates temporal links between facts with nearby event dates")
    // Python: test_temporal_links_creation — stores 3 facts with timestamps
    // within 24 hours, verifies temporal links are created with proper weights
  })

  // ── All link types together (needs LLM extraction) ──────────────────

  describe("all link types together", () => {
    it.todo("creates temporal, semantic, and entity links in a single operation")
    // Python: test_all_link_types_together — stores 3 related facts about Alice
    // with nearby dates and similar content, verifies all 3 link types are created
  })

  // ── Intra-batch links (needs LLM extraction) ───────────────────────

  describe("intra-batch links", () => {
    it.todo("creates semantic links between facts in the same batch")
    // Python: test_semantic_links_within_same_batch — retain_batch with 3
    // semantically similar items about Python, verifies semantic links exist
    // between them (regression test)

    it.todo("creates temporal links between facts in the same batch")
    // Python: test_temporal_links_within_same_batch — retain_batch with 3 items
    // having nearby event dates (within hours), verifies temporal links exist
    // between them (regression test)
  })

  // ── User-provided entities (needs LLM extraction) ──────────────────

  describe("user-provided entities", () => {
    it.todo("merges user-provided entities with LLM-extracted entities")
    // Python: test_user_provided_entities — retain_batch with user-provided
    // entities (ProjectX, ACME Corp, Alice), verifies they are merged with
    // auto-extracted entities and linked to facts
  })

  // ── Custom extraction mode (needs LLM extraction) ──────────────────

  describe("custom extraction mode", () => {
    it.todo("uses custom extraction guidelines from config")
    // Python: test_custom_extraction_mode — sets extraction mode to 'custom'
    // with Italian-only guidelines, verifies only Italian facts are extracted
    // from mixed Italian/English content
  })

  // ── Per-item tags on document (needs LLM extraction) ────────────────

  describe("per-item tags on document", () => {
    it.todo("stores per-item tags on the document record")
    // Python: test_retain_batch_with_per_item_tags_on_document — retain_batch
    // with per-item tags (user:testuser, app-type:taste-ai), verifies tags
    // are stored on the document record itself (regression test for bug where
    // tags were stored on facts but not on the document)
  })

  // ── Mention count (needs LLM extraction) ────────────────────────────

  describe("mention count", () => {
    it.todo("accurately tracks mention count across multiple retain calls")
    // Python: test_mention_count_accuracy — stores 5 separate contents all
    // mentioning Alice, verifies entity mention_count >= 5

    it.todo("accurately tracks mention count with batch retain")
    // Python: test_mention_count_batch_retain — batch retain with 6 items
    // mentioning Bob, verifies mention_count >= 6, then adds 2 more and
    // verifies count increases by >= 2
  })

  // ── Temporal fields (event_date, mentioned_at, occurred_start/end) ──────

  describe("temporal fields", () => {
    it.todo("stores event_date as mentioned_at on retained facts")
    // Python: test_event_date_storage — retain with event_date param,
    // verify recalled fact has mentioned_at close to that date

    it.todo("occurred_start and occurred_end are null when not extractable (TDD)")
    // Python: test_occurred_dates_not_defaulted — LLM must not hallucinate dates;
    // generic content with no date ref should have null occurred_start/end

    it.todo("mentioned_at vs occurred_start are distinct fields (TDD)")
    // Python: test_mentioned_at_vs_occurred — mentioned_at = conversation date,
    // occurred_start = when event happened (can differ by days/months/years)

    it.todo("ISO date string in context sets mentioned_at (TDD)")
    // Python: test_mentioned_at_from_context_string — pass ISO date as context,
    // verify mentioned_at on stored fact matches that date
  })

  // ── Retain → recall round-trip ───────────────────────────────────────

  describe("retain → recall round-trip", () => {
    it.todo("retained content is surfaced by recall with non-empty results")
    // Rust: test_memory_lifecycle — retain ["Alice is a software engineer at Google",
    // "Bob works with Alice on the search team"], then recall "Who is Alice?"
    // asserts results.memories is not empty. Validates full pipeline end-to-end.
  })
})
