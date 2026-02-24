/**
 * Phase 2 Verification — Gate 5: API Contract Verification
 *
 * listEpisodes:
 *   - sorted by last_event_at DESC
 *   - cursor pagination deterministic
 *   - scope filters applied correctly
 *
 * narrative:
 *   - supports before, after, both directions
 *   - returns deterministic order (event_time, event_id)
 *   - traverses across episode boundaries via temporal links
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  createTestHindsight,
  createTestBank,
  getHdb,
  type TestHindsight,
} from "./setup"

describe("Gate 5: API Contract Verification", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  // ── listEpisodes ───────────────────────────────────────────────────────

  describe("listEpisodes", () => {
    it("returns episodes sorted by last_event_at DESC", async () => {
      // Create episodes with different sessions to force separate episodes
      await t.hs.retain(bankId, "first", {
        facts: [{ content: "Fact for session A xyz 111", factType: "experience" }],
        session: "session-a",
        consolidate: false,
      })

      await t.hs.retain(bankId, "second", {
        facts: [{ content: "Fact for session B xyz 222", factType: "experience" }],
        session: "session-b",
        consolidate: false,
      })

      const result = await t.hs.listEpisodes(bankId)
      expect(result.items.length).toBeGreaterThanOrEqual(2)

      // Verify DESC ordering
      for (let i = 0; i < result.items.length - 1; i++) {
        expect(result.items[i]!.lastEventAt).toBeGreaterThanOrEqual(
          result.items[i + 1]!.lastEventAt,
        )
      }
    })

    it("cursor pagination is deterministic", async () => {
      // Create 5 episodes to test pagination
      for (let i = 0; i < 5; i++) {
        await t.hs.retain(bankId, `content-${i}`, {
          facts: [{ content: `Fact ${i} unique xyz ${i * 111}`, factType: "experience" }],
          session: `session-${i}`,
          consolidate: false,
        })
      }

      // Page 1
      const page1 = await t.hs.listEpisodes(bankId, { limit: 2 })
      expect(page1.items).toHaveLength(2)

      // Page 2
      expect(page1.cursor).not.toBeNull()
      const page2 = await t.hs.listEpisodes(bankId, {
        limit: 2,
        cursor: page1.cursor!,
      })
      expect(page2.items).toHaveLength(2)

      // Verify no overlap
      const page1Ids = new Set(page1.items.map((e) => e.episodeId))
      for (const item of page2.items) {
        expect(page1Ids.has(item.episodeId)).toBe(false)
      }

      // Page 3
      expect(page2.cursor).not.toBeNull()
      const page3 = await t.hs.listEpisodes(bankId, {
        limit: 2,
        cursor: page2.cursor!,
      })
      expect(page3.items).toHaveLength(1) // Only 1 remaining

      // Verify total
      expect(page1.total).toBe(5)
      expect(page2.total).toBe(5)
      expect(page3.total).toBe(5)
    })

    it("second run with same cursor returns same results", async () => {
      for (let i = 0; i < 3; i++) {
        await t.hs.retain(bankId, `content-${i}`, {
          facts: [{ content: `Fact ${i} unique abc ${i * 222}`, factType: "experience" }],
          session: `session-${i}`,
          consolidate: false,
        })
      }

      const page1 = await t.hs.listEpisodes(bankId, { limit: 1 })
      const page2a = await t.hs.listEpisodes(bankId, {
        limit: 1,
        cursor: page1.cursor!,
      })
      const page2b = await t.hs.listEpisodes(bankId, {
        limit: 1,
        cursor: page1.cursor!,
      })

      expect(page2a.items[0]!.episodeId).toBe(page2b.items[0]!.episodeId)
    })

    it("scope filters applied correctly — profile filter", async () => {
      await t.hs.retain(bankId, "alice-fact", {
        facts: [{ content: "Alice fact xyz 111", factType: "experience" }],
        profile: "alice",
        consolidate: false,
      })

      await t.hs.retain(bankId, "bob-fact", {
        facts: [{ content: "Bob fact xyz 222", factType: "experience" }],
        profile: "bob",
        consolidate: false,
      })

      const allEpisodes = await t.hs.listEpisodes(bankId)
      expect(allEpisodes.total).toBe(2)

      const aliceEpisodes = await t.hs.listEpisodes(bankId, { profile: "alice" })
      expect(aliceEpisodes.total).toBe(1)
      expect(aliceEpisodes.items[0]!.profile).toBe("alice")

      const bobEpisodes = await t.hs.listEpisodes(bankId, { profile: "bob" })
      expect(bobEpisodes.total).toBe(1)
      expect(bobEpisodes.items[0]!.profile).toBe("bob")
    })

    it("scope filters applied correctly — project filter", async () => {
      await t.hs.retain(bankId, "projA-fact", {
        facts: [{ content: "Project A fact xyz 111", factType: "experience" }],
        project: "project-a",
        consolidate: false,
      })

      await t.hs.retain(bankId, "projB-fact", {
        facts: [{ content: "Project B fact xyz 222", factType: "experience" }],
        project: "project-b",
        consolidate: false,
      })

      const projA = await t.hs.listEpisodes(bankId, { project: "project-a" })
      expect(projA.total).toBe(1)

      const projB = await t.hs.listEpisodes(bankId, { project: "project-b" })
      expect(projB.total).toBe(1)
    })

    it("scope filters applied correctly — session filter", async () => {
      await t.hs.retain(bankId, "s1-fact", {
        facts: [{ content: "Session 1 fact xyz 111", factType: "experience" }],
        session: "s1",
        consolidate: false,
      })

      await t.hs.retain(bankId, "s2-fact", {
        facts: [{ content: "Session 2 fact xyz 222", factType: "experience" }],
        session: "s2",
        consolidate: false,
      })

      const s1 = await t.hs.listEpisodes(bankId, { session: "s1" })
      expect(s1.total).toBe(1)
    })

    it("returns correct EpisodeSummary shape", async () => {
      await t.hs.retain(bankId, "first", {
        facts: [{ content: "Test fact xyz 111", factType: "experience" }],
        consolidate: false,
      })

      const result = await t.hs.listEpisodes(bankId)
      const episode = result.items[0]!

      // Verify all required fields exist
      expect(episode.episodeId).toBeDefined()
      expect(typeof episode.episodeId).toBe("string")
      expect(episode.startAt).toBeDefined()
      expect(typeof episode.startAt).toBe("number")
      expect(episode.lastEventAt).toBeDefined()
      expect(typeof episode.lastEventAt).toBe("number")
      expect(episode.eventCount).toBeDefined()
      expect(typeof episode.eventCount).toBe("number")
      expect(episode.boundaryReason).toBeDefined()
    })

    it("limit clamps between 1 and 100", async () => {
      await t.hs.retain(bankId, "test", {
        facts: [{ content: "Test fact xyz 111", factType: "experience" }],
        consolidate: false,
      })

      const result = await t.hs.listEpisodes(bankId, { limit: 0 })
      // Should clamp to at least 1
      expect(result.limit).toBeGreaterThanOrEqual(1)

      const result2 = await t.hs.listEpisodes(bankId, { limit: 1000 })
      // Should clamp to at most 100
      expect(result2.limit).toBeLessThanOrEqual(100)
    })
  })

  // ── narrative ──────────────────────────────────────────────────────────

  describe("narrative", () => {
    it("returns empty events for non-existent anchor", async () => {
      const result = await t.hs.narrative(bankId, {
        anchorMemoryId: "nonexistent-memory-id",
      })
      expect(result.events).toHaveLength(0)
      expect(result.anchorMemoryId).toBe("nonexistent-memory-id")
    })

    it("returns the anchor event in the result", async () => {
      const retainResult = await t.hs.retain(bankId, "test", {
        facts: [{ content: "Anchor fact xyz 111", factType: "experience" }],
        consolidate: false,
      })
      const anchorId = retainResult.memories[0]!.id

      const narr = await t.hs.narrative(bankId, { anchorMemoryId: anchorId })
      expect(narr.anchorMemoryId).toBe(anchorId)
      expect(narr.events.length).toBeGreaterThanOrEqual(1)

      const anchorEvent = narr.events.find((e) => e.memoryId === anchorId)
      expect(anchorEvent).toBeDefined()
    })

    it("supports direction=before", async () => {
      await t.hs.retain(bankId, "first", {
        facts: [{ content: "Earlier fact alpha xyz 111", factType: "experience" }],
        consolidate: false,
      })

      const r2 = await t.hs.retain(bankId, "second", {
        facts: [{ content: "Later fact beta xyz 222", factType: "experience" }],
        consolidate: false,
      })

      const anchorId = r2.memories[0]!.id
      const narr = await t.hs.narrative(bankId, {
        anchorMemoryId: anchorId,
        direction: "before",
      })

      expect(narr.events.length).toBeGreaterThanOrEqual(1)
      // Should include anchor
      const anchorEvent = narr.events.find((e) => e.memoryId === anchorId)
      expect(anchorEvent).toBeDefined()
    })

    it("supports direction=after", async () => {
      const r1 = await t.hs.retain(bankId, "first", {
        facts: [{ content: "Earlier fact alpha xyz 111", factType: "experience" }],
        consolidate: false,
      })

      await t.hs.retain(bankId, "second", {
        facts: [{ content: "Later fact beta xyz 222", factType: "experience" }],
        consolidate: false,
      })

      const anchorId = r1.memories[0]!.id
      const narr = await t.hs.narrative(bankId, {
        anchorMemoryId: anchorId,
        direction: "after",
      })

      expect(narr.events.length).toBeGreaterThanOrEqual(1)
    })

    it("supports direction=both (default)", async () => {
      await t.hs.retain(bankId, "first", {
        facts: [{ content: "First fact alpha xyz 111", factType: "experience" }],
        consolidate: false,
      })

      const r2 = await t.hs.retain(bankId, "second", {
        facts: [{ content: "Second fact beta xyz 222", factType: "experience" }],
        consolidate: false,
      })

      await t.hs.retain(bankId, "third", {
        facts: [{ content: "Third fact gamma xyz 333", factType: "experience" }],
        consolidate: false,
      })

      const anchorId = r2.memories[0]!.id
      const narr = await t.hs.narrative(bankId, {
        anchorMemoryId: anchorId,
        direction: "both",
      })

      expect(narr.events.length).toBeGreaterThanOrEqual(2)
    })

    it("returns events in deterministic order (event_time ASC)", async () => {
      await t.hs.retain(bankId, "batch", {
        facts: [
          { content: "Fact one alpha xyz 111", factType: "experience" },
          { content: "Fact two beta xyz 222", factType: "experience" },
          { content: "Fact three gamma xyz 333", factType: "experience" },
        ],
        consolidate: false,
      })

      const result = await t.hs.retain(bankId, "last", {
        facts: [{ content: "Fact four delta xyz 444", factType: "experience" }],
        consolidate: false,
      })

      const anchorId = result.memories[0]!.id
      const narr = await t.hs.narrative(bankId, {
        anchorMemoryId: anchorId,
        direction: "before",
      })

      // Events before anchor should be in ascending order
      for (let i = 0; i < narr.events.length - 1; i++) {
        expect(narr.events[i]!.eventTime).toBeLessThanOrEqual(
          narr.events[i + 1]!.eventTime,
        )
      }
    })

    it("traverses across episode boundaries via temporal links", async () => {
      // Episode 1 — same scope (null session) so resolveEpisode can find and
      // link consecutive episodes via temporal links.
      await t.hs.retain(bankId, "ep1-fact", {
        facts: [{ content: "Episode 1 fact alpha xyz 111", factType: "experience" }],
        consolidate: false,
      })

      // Episode 2 — phrase boundary triggers a new episode while preserving
      // the scope lineage needed for temporal link creation.
      const r2 = await t.hs.retain(bankId, "ep2-fact", {
        facts: [{ content: "new task Episode 2 fact beta xyz 222", factType: "experience" }],
        consolidate: false,
      })

      // Verify episodes were created
      const episodes = await t.hs.listEpisodes(bankId)
      expect(episodes.total).toBe(2)

      // Narrative from episode 2 anchor looking backward should reach episode 1
      const anchorId = r2.memories[0]!.id
      const narr = await t.hs.narrative(bankId, {
        anchorMemoryId: anchorId,
        direction: "before",
      })

      // Should include events from both episodes
      const episodeIds = new Set(narr.events.map((e) => e.episodeId))
      expect(episodeIds.size).toBeGreaterThanOrEqual(2)
    })

    it("narrative events have correct NarrativeEvent shape", async () => {
      const result = await t.hs.retain(bankId, "test", {
        facts: [{ content: "Shape test fact xyz 111", factType: "experience" }],
        consolidate: false,
      })

      const anchorId = result.memories[0]!.id
      const narr = await t.hs.narrative(bankId, { anchorMemoryId: anchorId })

      for (const event of narr.events) {
        expect(typeof event.memoryId).toBe("string")
        expect(typeof event.episodeId).toBe("string")
        expect(typeof event.eventTime).toBe("number")
        expect(typeof event.route).toBe("string")
        expect(typeof event.contentSnippet).toBe("string")
        expect(["reinforce", "reconsolidate", "new_trace"]).toContain(event.route)
      }
    })

    it("steps parameter limits traversal depth", async () => {
      // Create multiple episodes
      for (let i = 0; i < 5; i++) {
        await t.hs.retain(bankId, `ep${i}-fact`, {
          facts: [{ content: `Episode ${i} fact xyz ${i * 111}`, factType: "experience" }],
          session: `session-${i}`,
          consolidate: false,
        })
      }

      const episodes = await t.hs.listEpisodes(bankId)
      const lastEpisode = episodes.items[0]! // Most recent

      // Get a memory from the last episode
      const hdb = getHdb(t.hs)
      const lastEvent = hdb.sqlite
        .prepare(
          "SELECT memory_id FROM hs_episode_events WHERE episode_id = ? LIMIT 1",
        )
        .get(lastEpisode.episodeId) as { memory_id: string } | undefined

      expect(lastEvent).toBeDefined()

      const narr = await t.hs.narrative(bankId, {
        anchorMemoryId: lastEvent!.memory_id,
        direction: "before",
        steps: 1,
      })

      // With steps=1, should only traverse 1 episode back
      const episodeIds = new Set(narr.events.map((e) => e.episodeId))
      expect(episodeIds.size).toBeLessThanOrEqual(2) // anchor episode + 1 step back
    })
  })
})
