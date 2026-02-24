/**
 * Phase 2 Verification — Gate 2: Conflict Detection v1
 *
 * Verifies:
 * - Keying is exactly entity+attribute (name|entity_type)
 * - Changed value detection with normalization:
 *   - case-insensitive
 *   - trimmed whitespace
 *   - normalized numeric strings
 * - Same key/same normalized value => non-conflict
 * - Same key/different normalized value => conflict
 */

import { describe, it, expect } from "bun:test"
import { detectConflict } from "../routing"

describe("Gate 2: Conflict Detection v1", () => {
  // ── Key structure verification ─────────────────────────────────────────

  describe("key structure is entity name + attribute (entity_type)", () => {
    it("conflict key format is name|entity_type", () => {
      const candidate = [{ name: "Alice", entityType: "person" }]
      const incoming = [{ name: "Alice", entityType: "organization" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(true)
      expect(result.conflictKeys).toHaveLength(1)
      expect(result.conflictKeys[0]).toBe("alice|entity_type")
    })

    it("disjoint entity names => no conflict", () => {
      const candidate = [{ name: "Alice", entityType: "person" }]
      const incoming = [{ name: "Bob", entityType: "organization" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(false)
      expect(result.conflictKeys).toHaveLength(0)
    })
  })

  // ── Case-insensitive normalization ──────────────────────────────────────

  describe("case-insensitive normalization", () => {
    it("same value in different case => non-conflict", () => {
      const candidate = [{ name: "Alice", entityType: "PERSON" }]
      const incoming = [{ name: "Alice", entityType: "person" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(false)
    })

    it("same name in different case resolves to same key", () => {
      const candidate = [{ name: "ALICE", entityType: "person" }]
      const incoming = [{ name: "alice", entityType: "person" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(false)
    })

    it("mixed case name with different type => conflict", () => {
      const candidate = [{ name: "Alice BOB", entityType: "person" }]
      const incoming = [{ name: "alice bob", entityType: "place" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(true)
    })
  })

  // ── Whitespace normalization ────────────────────────────────────────────

  describe("whitespace normalization", () => {
    it("leading/trailing whitespace is trimmed => non-conflict", () => {
      const candidate = [{ name: "  Alice  ", entityType: "  person  " }]
      const incoming = [{ name: "Alice", entityType: "person" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(false)
    })

    it("internal multi-space collapsed to single space", () => {
      const candidate = [{ name: "Alice   Bob", entityType: "person" }]
      const incoming = [{ name: "Alice Bob", entityType: "person" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(false)
    })
  })

  // ── Numeric normalization ──────────────────────────────────────────────

  describe("numeric string normalization", () => {
    it("01.0 and 1 normalize to same value => non-conflict", () => {
      const candidate = [{ name: "Score", entityType: "01.0" }]
      const incoming = [{ name: "Score", entityType: "1" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(false)
    })

    it("1.00 and 1 normalize to same value => non-conflict", () => {
      const candidate = [{ name: "Count", entityType: "1.00" }]
      const incoming = [{ name: "Count", entityType: "1" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(false)
    })

    it("+5 and 5 normalize to same value => non-conflict", () => {
      const candidate = [{ name: "Level", entityType: "+5" }]
      const incoming = [{ name: "Level", entityType: "5" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(false)
    })

    it("numeric 1 and string 'one' => conflict", () => {
      const candidate = [{ name: "Rank", entityType: "1" }]
      const incoming = [{ name: "Rank", entityType: "one" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(true)
    })
  })

  // ── Empty array handling ────────────────────────────────────────────────

  describe("empty entity arrays", () => {
    it("both empty => no conflict", () => {
      const result = detectConflict([], [])
      expect(result.conflictDetected).toBe(false)
      expect(result.conflictKeys).toHaveLength(0)
    })

    it("candidate empty => no conflict", () => {
      const result = detectConflict([], [{ name: "A", entityType: "person" }])
      expect(result.conflictDetected).toBe(false)
    })

    it("incoming empty => no conflict", () => {
      const result = detectConflict([{ name: "A", entityType: "person" }], [])
      expect(result.conflictDetected).toBe(false)
    })
  })

  // ── Multiple entities ──────────────────────────────────────────────────

  describe("multiple entities", () => {
    it("detects conflict for one entity among many", () => {
      const candidate = [
        { name: "Alice", entityType: "person" },
        { name: "Acme", entityType: "organization" },
      ]
      const incoming = [
        { name: "Alice", entityType: "person" },
        { name: "Acme", entityType: "place" },
      ]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(true)
      expect(result.conflictKeys).toHaveLength(1)
      expect(result.conflictKeys[0]).toBe("acme|entity_type")
    })

    it("detects multiple conflicts", () => {
      const candidate = [
        { name: "Alice", entityType: "person" },
        { name: "Acme", entityType: "organization" },
      ]
      const incoming = [
        { name: "Alice", entityType: "place" },
        { name: "Acme", entityType: "concept" },
      ]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(true)
      expect(result.conflictKeys).toHaveLength(2)
    })

    it("no conflict when all entities match", () => {
      const candidate = [
        { name: "Alice", entityType: "person" },
        { name: "Acme", entityType: "organization" },
      ]
      const incoming = [
        { name: "Alice", entityType: "person" },
        { name: "Acme", entityType: "organization" },
      ]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(false)
      expect(result.conflictKeys).toHaveLength(0)
    })
  })

  // ── Combined normalization ─────────────────────────────────────────────

  describe("combined normalization (case + whitespace + numeric)", () => {
    it("all normalizations applied together => non-conflict", () => {
      const candidate = [{ name: "  ALICE  ", entityType: "  PERSON  " }]
      const incoming = [{ name: "alice", entityType: "person" }]
      const result = detectConflict(candidate, incoming)
      expect(result.conflictDetected).toBe(false)
    })
  })
})
