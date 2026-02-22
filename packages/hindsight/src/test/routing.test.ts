/**
 * Tests for routing.ts — reconsolidation routing engine.
 *
 * Tests the pure classification logic, conflict detection, and integration
 * with the retain flow (reinforce / reconsolidate / new_trace).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"
import {
  classifyRoute,
  detectConflict,
  REINFORCE_THRESHOLD,
  RECONSOLIDATE_THRESHOLD,
} from "../routing"

// ── Pure classification tests ────────────────────────────────────────────────

describe("classifyRoute", () => {
  it("returns reinforce for score >= 0.92 with no conflict", () => {
    expect(classifyRoute(0.92, false)).toBe("reinforce")
    expect(classifyRoute(0.95, false)).toBe("reinforce")
    expect(classifyRoute(1.0, false)).toBe("reinforce")
  })

  it("returns reconsolidate for score just below 0.92 with no conflict", () => {
    expect(classifyRoute(0.9199, false)).toBe("reconsolidate")
    expect(classifyRoute(0.85, false)).toBe("reconsolidate")
    expect(classifyRoute(0.78, false)).toBe("reconsolidate")
  })

  it("returns reconsolidate for any score >= 0.78 with conflict", () => {
    expect(classifyRoute(0.95, true)).toBe("reconsolidate")
    expect(classifyRoute(0.92, true)).toBe("reconsolidate")
    expect(classifyRoute(0.80, true)).toBe("reconsolidate")
    expect(classifyRoute(0.78, true)).toBe("reconsolidate")
  })

  it("returns new_trace for score below 0.78", () => {
    expect(classifyRoute(0.77, false)).toBe("new_trace")
    expect(classifyRoute(0.5, false)).toBe("new_trace")
    expect(classifyRoute(0.0, false)).toBe("new_trace")
  })

  it("returns reconsolidate for score below 0.78 when conflict is present", () => {
    expect(classifyRoute(0.77, true)).toBe("reconsolidate")
    expect(classifyRoute(0.5, true)).toBe("reconsolidate")
  })
})

// ── Conflict detection tests ─────────────────────────────────────────────────

describe("detectConflict", () => {
  it("returns no conflict for same entity key/value", () => {
    const candidate = [{ name: "Alice", entityType: "person" }]
    const incoming = [{ name: "Alice", entityType: "person" }]
    const result = detectConflict(candidate, incoming)
    expect(result.conflictDetected).toBe(false)
    expect(result.conflictKeys).toHaveLength(0)
  })

  it("returns conflict for same name with different entityType", () => {
    const candidate = [{ name: "Alice", entityType: "person" }]
    const incoming = [{ name: "Alice", entityType: "organization" }]
    const result = detectConflict(candidate, incoming)
    expect(result.conflictDetected).toBe(true)
    expect(result.conflictKeys).toContain("alice|entity_type")
  })

  it("normalizes case and whitespace for comparison", () => {
    const candidate = [{ name: "  ALICE  ", entityType: "person" }]
    const incoming = [{ name: "alice", entityType: "person" }]
    const result = detectConflict(candidate, incoming)
    expect(result.conflictDetected).toBe(false)
  })

  it("normalizes numeric strings for comparison", () => {
    const candidate = [{ name: "Alice", entityType: "01.0" }]
    const incoming = [{ name: "Alice", entityType: "1" }]
    const result = detectConflict(candidate, incoming)
    expect(result.conflictDetected).toBe(false)
  })

  it("returns no conflict when entities are disjoint", () => {
    const candidate = [{ name: "Alice", entityType: "person" }]
    const incoming = [{ name: "Bob", entityType: "person" }]
    const result = detectConflict(candidate, incoming)
    expect(result.conflictDetected).toBe(false)
  })

  it("handles empty entity arrays", () => {
    expect(detectConflict([], []).conflictDetected).toBe(false)
    expect(detectConflict([], [{ name: "A", entityType: "person" }]).conflictDetected).toBe(false)
    expect(detectConflict([{ name: "A", entityType: "person" }], []).conflictDetected).toBe(false)
  })
})

// ── Integration tests ────────────────────────────────────────────────────────

describe("routing integration via retain", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  it("stores a new fact as new_trace when no candidate exists", async () => {
    const result = await t.hs.retain(bankId, "test content", {
      facts: [{ content: "Alice works at Acme Corp", factType: "world" }],
    })
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0]!.content).toBe("Alice works at Acme Corp")
  })

  it("reinforces exact duplicate — preserves content, bumps metadata", async () => {
    // First retain
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice works at Acme Corp", factType: "world" }],
      dedupThreshold: 0.92,
    })

    // Second retain with exact same content — should reinforce
    const result = await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice works at Acme Corp", factType: "world" }],
      dedupThreshold: 0.92,
    })

    // Should return the reinforced memory (content unchanged)
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0]!.content).toBe("Alice works at Acme Corp")
  })

  it("creates new_trace for radically different content", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice works at Acme Corp", factType: "world" }],
      dedupThreshold: 0.92,
    })

    // Very different content
    const result = await t.hs.retain(bankId, "test", {
      facts: [{ content: "xyz 123 !@# totally different", factType: "experience" }],
    })

    // Should be a new_trace
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0]!.content).toBe("xyz 123 !@# totally different")
  })

  it("logs reconsolidation decisions to the audit table", async () => {
    // First retain
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice works at Acme Corp", factType: "world" }],
      dedupThreshold: 0.92,
    })

    // Second retain
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice works at Acme Corp", factType: "world" }],
      dedupThreshold: 0.92,
    })

    // Check that decisions were logged
    const decisions = (t.hs as any).hdb.db
      .select()
      .from((t.hs as any).hdb.schema.reconsolidationDecisions)
      .all()

    expect(decisions.length).toBeGreaterThan(0)
    expect(decisions[0]!.policyVersion).toBe("v1")
  })
})
