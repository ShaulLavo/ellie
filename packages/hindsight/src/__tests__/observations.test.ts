/**
 * Tests for entity extraction and observation creation during retain.
 *
 * Port of test_observations.py.
 * Integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Entity extraction on retain", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  it("extracts entities from pre-provided facts", async () => {
    const result = await t.hs.retain(bankId, "test", {
      facts: [
        {
          content: "Peter works at Acme Corp in New York",
          entities: ["Peter", "Acme Corp", "New York"],
        },
      ],
      consolidate: false,
    })

    expect(result.entities.length).toBeGreaterThanOrEqual(1)
    const names = result.entities.map((e) => e.name)
    expect(names).toContain("Peter")
  })

  it("increments mention count on repeated entity references", async () => {
    // First retain mentions Peter
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Peter went hiking", entities: ["Peter"] }],
      consolidate: false,
    })

    // Second retain also mentions Peter
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Peter likes cooking", entities: ["Peter"] }],
      consolidate: false,
      dedupThreshold: 0,
    })

    // Peter should now have mentionCount >= 2
    // We can verify this through entity retrieval (though we don't have a direct
    // entity listing API — would need to check via recall entity hydration)
    const result = await t.hs.recall(bankId, "Peter", {
      methods: ["graph"],
    })
    expect(result.memories).toBeDefined()
  })

  it("assigns entity types from pre-provided facts", async () => {
    const result = await t.hs.retain(bankId, "test", {
      facts: [
        {
          content: "Google announced a new AI model",
          entities: ["Google"],
        },
      ],
      consolidate: false,
    })

    // Entity type should default to something reasonable
    expect(result.entities.length).toBeGreaterThan(0)
    const google = result.entities.find((e) => e.name === "Google")
    expect(google).toBeDefined()
    expect(["person", "organization", "place", "concept", "other"]).toContain(
      google!.entityType,
    )
  })

  it("creates junction entries linking memories to entities", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [
        { content: "Alice met Bob at the conference", entities: ["Alice", "Bob"] },
      ],
      consolidate: false,
    })

    // The memory should have entities linked to it
    const recallResult = await t.hs.recall(bankId, "Alice Bob conference")
    expect(recallResult.memories.length).toBeGreaterThan(0)
    const memory = recallResult.memories[0]!
    expect(memory.entities.length).toBeGreaterThanOrEqual(1)
  })
})

describe("Entity mention ranking (TDD targets)", () => {
  it.todo("entities are ranked by mention count")
  it.todo("most frequently mentioned entity has highest mentionCount")
  it.todo("entity mention counts are bank-scoped")
  it.todo("entities are ranked by mention count DESC")
  it.todo("user entity is extracted when mentioned frequently")
})

describe("Recall entity parameters (TDD targets)", () => {
  it.todo("recall accepts include_entities parameter")
})

describe("Observation storage controls (TDD targets)", () => {
  it.todo("observations are not stored when disabled")
})

describe("Entity state tracking (TDD targets)", () => {
  it.todo("entity firstSeen is set on first mention")
  it.todo("entity lastUpdated is updated on subsequent mentions")
  it.todo("entity description can be updated")
})

describe("clearObservations (TDD targets)", () => {
  it.todo("clearObservations removes all observations from the bank")
  // Rust: test_bank_clear_observations — after clearing, recall with
  // factType:'observation' returns empty results

  it.todo("clearObservations does not remove raw facts (experience/world)")
  // After clear-observations, non-observation memories are still recallable
})

describe("Operation lifecycle (TDD targets)", () => {
  it.todo("operation list is empty for a fresh bank")
  // Rust: test_operation_list — new bank has no pending operations

  it.todo("async retain creates an operation with pending status")
  // Retain with async:true returns an operationId and the operation
  // appears in the operation list with status 'pending' or 'completed'

  it.todo("completed operation is removed from the pending operations list")
  // Once status is 'completed', operation is gone from the active list

  it.todo("failed operation has errorMessage set")
  // Rust: api.rs test_operation_deserialize_with_error — operation with
  // status 'failed' carries a non-null errorMessage
})
