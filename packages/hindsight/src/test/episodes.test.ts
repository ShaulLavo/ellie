/**
 * Tests for episodes.ts — episodic timeline management.
 *
 * Tests boundary detection, episode creation/resolution,
 * event recording, listEpisodes, and narrative queries.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"
import { detectBoundary } from "../episodes"
import type { EpisodeRow } from "../schema"

// ── Helper: create a fake episode row for boundary detection ─────────────────

function fakeEpisode(overrides: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    id: "ep-1",
    bankId: "bank-1",
    profile: null,
    project: null,
    session: null,
    startAt: Date.now() - 1000,
    endAt: null,
    lastEventAt: Date.now() - 1000,
    eventCount: 1,
    boundaryReason: null,
    ...overrides,
  }
}

// ── Boundary detection (pure) ────────────────────────────────────────────────

describe("detectBoundary", () => {
  it("returns needsNew=true with reason=initial when no last episode", () => {
    const result = detectBoundary(null, Date.now(), null, null, null)
    expect(result.needsNew).toBe(true)
    expect(result.reason).toBe("initial")
  })

  it("returns needsNew=false when within time gap and same scope", () => {
    const now = Date.now()
    const ep = fakeEpisode({ lastEventAt: now - 10_000 }) // 10s ago
    const result = detectBoundary(ep, now, null, null, null)
    expect(result.needsNew).toBe(false)
    expect(result.reason).toBeNull()
  })

  it("returns needsNew=true with reason=time_gap after 46 minutes", () => {
    const now = Date.now()
    const ep = fakeEpisode({ lastEventAt: now - 46 * 60 * 1000 })
    const result = detectBoundary(ep, now, null, null, null)
    expect(result.needsNew).toBe(true)
    expect(result.reason).toBe("time_gap")
  })

  it("returns needsNew=true with reason=scope_change on profile change", () => {
    const now = Date.now()
    const ep = fakeEpisode({ lastEventAt: now - 1000, profile: "alice" })
    const result = detectBoundary(ep, now, "bob", null, null)
    expect(result.needsNew).toBe(true)
    expect(result.reason).toBe("scope_change")
  })

  it("returns needsNew=true with reason=scope_change on project change", () => {
    const now = Date.now()
    const ep = fakeEpisode({ lastEventAt: now - 1000, project: "project-a" })
    const result = detectBoundary(ep, now, null, "project-b", null)
    expect(result.needsNew).toBe(true)
    expect(result.reason).toBe("scope_change")
  })

  it("returns needsNew=true with reason=scope_change on session change", () => {
    const now = Date.now()
    const ep = fakeEpisode({ lastEventAt: now - 1000, session: "s1" })
    const result = detectBoundary(ep, now, null, null, "s2")
    expect(result.needsNew).toBe(true)
    expect(result.reason).toBe("scope_change")
  })

  it("returns needsNew=true with reason=phrase_boundary for 'new task'", () => {
    const now = Date.now()
    const ep = fakeEpisode({ lastEventAt: now - 1000 })
    const result = detectBoundary(ep, now, null, null, null, "I have a new task to work on")
    expect(result.needsNew).toBe(true)
    expect(result.reason).toBe("phrase_boundary")
  })

  it("returns needsNew=true with reason=phrase_boundary for 'switching to'", () => {
    const now = Date.now()
    const ep = fakeEpisode({ lastEventAt: now - 1000 })
    const result = detectBoundary(ep, now, null, null, null, "I'm switching to another project")
    expect(result.needsNew).toBe(true)
    expect(result.reason).toBe("phrase_boundary")
  })

  it("returns needsNew=true with reason=phrase_boundary for 'done with'", () => {
    const now = Date.now()
    const ep = fakeEpisode({ lastEventAt: now - 1000 })
    const result = detectBoundary(ep, now, null, null, null, "I'm done with this feature")
    expect(result.needsNew).toBe(true)
    expect(result.reason).toBe("phrase_boundary")
  })

  it("phrase boundary takes precedence over time gap", () => {
    const now = Date.now()
    // Both time gap AND phrase boundary triggered
    const ep = fakeEpisode({ lastEventAt: now - 60 * 60 * 1000 }) // 1hr ago
    const result = detectBoundary(ep, now, null, null, null, "new task here")
    expect(result.reason).toBe("phrase_boundary")
  })
})

// ── Integration: episodes via retain ─────────────────────────────────────────

describe("episodes via retain integration", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  it("first retain creates an episode", async () => {
    await t.hs.retain(bankId, "test content", {
      facts: [{ content: "Alice likes coffee", factType: "experience" }],
    })

    const episodes = t.hs.listEpisodes(bankId)
    expect(episodes.items).toHaveLength(1)
    expect(episodes.total).toBe(1)
  })

  it("retain within 45 minutes extends the same episode", async () => {
    await t.hs.retain(bankId, "first", {
      facts: [{ content: "Alice likes coffee", factType: "experience" }],
    })

    await t.hs.retain(bankId, "second", {
      facts: [{ content: "Bob likes tea xyz 123", factType: "experience" }],
    })

    const episodes = t.hs.listEpisodes(bankId)
    expect(episodes.items).toHaveLength(1)
    expect(episodes.items[0]!.eventCount).toBeGreaterThanOrEqual(2)
  })

  it("retain with different session creates new episode", async () => {
    await t.hs.retain(bankId, "first", {
      facts: [{ content: "Alice likes coffee", factType: "experience" }],
      session: "session-1",
    })

    await t.hs.retain(bankId, "second", {
      facts: [{ content: "Bob likes tea xyz 123", factType: "experience" }],
      session: "session-2",
    })

    const episodes = t.hs.listEpisodes(bankId)
    expect(episodes.items).toHaveLength(2)
  })

  it("temporal link is created between consecutive episodes", async () => {
    await t.hs.retain(bankId, "first", {
      facts: [{ content: "Alice likes coffee", factType: "experience" }],
      session: "session-1",
    })

    await t.hs.retain(bankId, "second", {
      facts: [{ content: "Bob likes tea xyz 123", factType: "experience" }],
      session: "session-2",
    })

    // Check temporal links exist
    const links = (t.hs as any).hdb.db
      .select()
      .from((t.hs as any).hdb.schema.episodeTemporalLinks)
      .all()

    expect(links).toHaveLength(1)
  })

  it("listEpisodes supports scope filtering", async () => {
    await t.hs.retain(bankId, "first", {
      facts: [{ content: "Alice likes coffee", factType: "experience" }],
      profile: "alice",
    })

    await t.hs.retain(bankId, "second", {
      facts: [{ content: "Bob likes tea xyz 123", factType: "experience" }],
      profile: "bob",
    })

    const allEpisodes = t.hs.listEpisodes(bankId)
    expect(allEpisodes.total).toBe(2)

    const aliceEpisodes = t.hs.listEpisodes(bankId, { profile: "alice" })
    expect(aliceEpisodes.total).toBe(1)
  })

  it("narrative returns events around an anchor memory", async () => {
    const result1 = await t.hs.retain(bankId, "first", {
      facts: [{ content: "Alice likes coffee", factType: "experience" }],
    })

    const result2 = await t.hs.retain(bankId, "second", {
      facts: [{ content: "Bob likes tea xyz 123", factType: "experience" }],
    })

    const anchorId = result2.memories[0]!.id

    const narr = t.hs.narrative(bankId, { anchorMemoryId: anchorId })
    expect(narr.anchorMemoryId).toBe(anchorId)
    expect(narr.events.length).toBeGreaterThanOrEqual(1)
  })

  it("narrative returns empty for non-existent anchor", () => {
    const narr = t.hs.narrative(bankId, { anchorMemoryId: "nonexistent" })
    expect(narr.events).toHaveLength(0)
  })

  it("episode eventCount increments correctly", async () => {
    await t.hs.retain(bankId, "batch", {
      facts: [
        { content: "Fact one about alpha", factType: "world" },
        { content: "Fact two about beta xyz 123", factType: "world" },
        { content: "Fact three about gamma !@# 456", factType: "world" },
      ],
    })

    const episodes = t.hs.listEpisodes(bankId)
    expect(episodes.items).toHaveLength(1)
    expect(episodes.items[0]!.eventCount).toBe(3)
  })
})
