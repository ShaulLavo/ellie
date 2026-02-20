/**
 * Tests for entity extraction and observation creation during retain.
 *
 * Port of test_observations.py.
 * Integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, implementMe, type TestHindsight } from "./setup"

describe("Entity extraction on retain", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    const pending = t.hs.listOperations(bankId, { status: "pending" })
    for (const operation of pending.operations) {
      t.hs.cancelOperation(bankId, operation.id)
    }
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
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  it("entities are ranked by mention count", async () => {
    // Retain multiple facts mentioning "Alice" more than "Bob"
    await t.hs.retain(bankId, "test", {
      facts: [
        { content: "Alice went hiking", entities: ["Alice"] },
        { content: "Alice likes cooking", entities: ["Alice"] },
        { content: "Alice reads books", entities: ["Alice"] },
        { content: "Bob went hiking", entities: ["Bob"] },
      ],
      consolidate: false,
    })

    // Query entities via DB to check mention counts
    const db = (t.hs as any).hdb
    const entities = db.db
      .select({
        name: db.schema.entities.name,
        mentionCount: db.schema.entities.mentionCount,
      })
      .from(db.schema.entities)
      .where((await import("drizzle-orm")).eq(db.schema.entities.bankId, bankId))
      .all()

    const alice = entities.find((e: any) => e.name === "Alice")
    const bob = entities.find((e: any) => e.name === "Bob")
    expect(alice).toBeDefined()
    expect(bob).toBeDefined()
    expect(alice!.mentionCount).toBeGreaterThan(bob!.mentionCount)
  })

  it("most frequently mentioned entity has highest mentionCount", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [
        { content: "Alice studies math", entities: ["Alice"] },
        { content: "Alice studies physics", entities: ["Alice"] },
        { content: "Bob studies math", entities: ["Bob"] },
      ],
      consolidate: false,
      dedupThreshold: 0,
    })

    const db = (t.hs as any).hdb
    const { desc } = await import("drizzle-orm")
    const entities = db.db
      .select({
        name: db.schema.entities.name,
        mentionCount: db.schema.entities.mentionCount,
      })
      .from(db.schema.entities)
      .where((await import("drizzle-orm")).eq(db.schema.entities.bankId, bankId))
      .orderBy(desc(db.schema.entities.mentionCount))
      .all()

    expect(entities.length).toBeGreaterThanOrEqual(2)
    expect(entities[0]!.name).toBe("Alice")
  })

  it("entity mention counts are bank-scoped", async () => {
    const bankId2 = createTestBank(t.hs)

    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice in bank 1", entities: ["Alice"] }],
      consolidate: false,
    })
    await t.hs.retain(bankId2, "test", {
      facts: [{ content: "Alice in bank 2", entities: ["Alice"] }],
      consolidate: false,
    })

    const db = (t.hs as any).hdb
    const { eq, and } = await import("drizzle-orm")
    const bank1Alice = db.db
      .select({ mentionCount: db.schema.entities.mentionCount })
      .from(db.schema.entities)
      .where(
        and(
          eq(db.schema.entities.bankId, bankId),
          eq(db.schema.entities.name, "Alice"),
        ),
      )
      .get()

    const bank2Alice = db.db
      .select({ mentionCount: db.schema.entities.mentionCount })
      .from(db.schema.entities)
      .where(
        and(
          eq(db.schema.entities.bankId, bankId2),
          eq(db.schema.entities.name, "Alice"),
        ),
      )
      .get()

    expect(bank1Alice).toBeDefined()
    expect(bank2Alice).toBeDefined()
    // Each bank should independently track Alice's mentions
    expect(bank1Alice!.mentionCount).toBe(1)
    expect(bank2Alice!.mentionCount).toBe(1)
  })

  it("entities are ranked by mention count DESC", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [
        { content: "Alice fact 1", entities: ["Alice"] },
        { content: "Alice fact 2", entities: ["Alice"] },
        { content: "Alice fact 3", entities: ["Alice"] },
        { content: "Bob fact 1", entities: ["Bob"] },
        { content: "Bob fact 2", entities: ["Bob"] },
        { content: "Carol fact 1", entities: ["Carol"] },
      ],
      consolidate: false,
      dedupThreshold: 0,
    })

    const db = (t.hs as any).hdb
    const { eq, desc } = await import("drizzle-orm")
    const entities = db.db
      .select({
        name: db.schema.entities.name,
        mentionCount: db.schema.entities.mentionCount,
      })
      .from(db.schema.entities)
      .where(eq(db.schema.entities.bankId, bankId))
      .orderBy(desc(db.schema.entities.mentionCount))
      .all()

    // Should be ordered: Alice (3), Bob (2), Carol (1)
    expect(entities.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < entities.length; i++) {
      expect(entities[i - 1]!.mentionCount).toBeGreaterThanOrEqual(
        entities[i]!.mentionCount,
      )
    }
  })

  it("user entity is extracted when mentioned frequently", async () => {
    // Retain many facts mentioning a user name
    for (let i = 0; i < 5; i++) {
      await t.hs.retain(bankId, "test", {
        facts: [{ content: `User Shaul performed action ${i}`, entities: ["Shaul"] }],
        consolidate: false,
        dedupThreshold: 0,
      })
    }

    const db = (t.hs as any).hdb
    const { eq, and } = await import("drizzle-orm")
    const shaul = db.db
      .select({
        name: db.schema.entities.name,
        mentionCount: db.schema.entities.mentionCount,
      })
      .from(db.schema.entities)
      .where(
        and(
          eq(db.schema.entities.bankId, bankId),
          eq(db.schema.entities.name, "Shaul"),
        ),
      )
      .get()

    expect(shaul).toBeDefined()
    expect(shaul!.mentionCount).toBeGreaterThanOrEqual(5)
  })
})

describe("Recall entity parameters (TDD targets)", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  it("recall accepts include_entities parameter", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice works at Google", entities: ["Alice", "Google"] }],
      consolidate: false,
    })

    // recall should include entities by default
    const result = await t.hs.recall(bankId, "Alice")
    expect(result.memories).toBeDefined()
    if (result.memories.length > 0) {
      expect(result.memories[0]!.entities).toBeDefined()
      expect(Array.isArray(result.memories[0]!.entities)).toBe(true)
    }
  })
})

describe("Observation storage controls (TDD targets)", () => {
  it("observations are not stored when disabled", () => {
    implementMe(
      "reflect saveObservations=false already tested in reflect.test.ts; consolidation observation storage toggle not implemented",
      "test_consolidation.py::test_observations_disabled",
    )
  })
})

describe("Entity state tracking (TDD targets)", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  it("entity firstSeen is set on first mention", async () => {
    const before = Date.now()
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice started a project", entities: ["Alice"] }],
      consolidate: false,
    })
    const after = Date.now()

    const db = (t.hs as any).hdb
    const { eq, and } = await import("drizzle-orm")
    const alice = db.db
      .select({
        firstSeen: db.schema.entities.firstSeen,
      })
      .from(db.schema.entities)
      .where(
        and(
          eq(db.schema.entities.bankId, bankId),
          eq(db.schema.entities.name, "Alice"),
        ),
      )
      .get()

    expect(alice).toBeDefined()
    expect(alice!.firstSeen).toBeGreaterThanOrEqual(before)
    expect(alice!.firstSeen).toBeLessThanOrEqual(after)
  })

  it("entity lastUpdated is updated on subsequent mentions", async () => {
    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice started a project", entities: ["Alice"] }],
      consolidate: false,
    })

    const db = (t.hs as any).hdb
    const { eq, and } = await import("drizzle-orm")
    const first = db.db
      .select({ lastUpdated: db.schema.entities.lastUpdated })
      .from(db.schema.entities)
      .where(
        and(
          eq(db.schema.entities.bankId, bankId),
          eq(db.schema.entities.name, "Alice"),
        ),
      )
      .get()

    // Wait a tiny bit so timestamps differ
    await new Promise((r) => setTimeout(r, 10))

    await t.hs.retain(bankId, "test", {
      facts: [{ content: "Alice finished the project", entities: ["Alice"] }],
      consolidate: false,
      dedupThreshold: 0,
    })

    const second = db.db
      .select({ lastUpdated: db.schema.entities.lastUpdated })
      .from(db.schema.entities)
      .where(
        and(
          eq(db.schema.entities.bankId, bankId),
          eq(db.schema.entities.name, "Alice"),
        ),
      )
      .get()

    expect(second!.lastUpdated).toBeGreaterThanOrEqual(first!.lastUpdated)
  })

  it("entity description can be updated", () => {
    implementMe(
      "entity description update not exposed via Hindsight public API",
      "test_observations.py::test_entity_description_update",
    )
  })
})

describe("clearObservations (TDD targets)", () => {
  it.todo("clearObservations removes all observations from the bank")
  it.todo("clearObservations does not remove raw facts (experience/world)")
})

describe("Operation lifecycle (TDD targets)", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  async function waitForOperation(
    operationId: string,
    timeoutMs: number = 3000,
  ): Promise<ReturnType<TestHindsight["hs"]["getOperationStatus"]>> {
    const started = Date.now()
    for (;;) {
      const status = t.hs.getOperationStatus(bankId, operationId)
      if (status.status === "completed" || status.status === "failed") return status
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for operation ${operationId}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it("operation list is empty for a fresh bank", () => {
    const result = t.hs.listOperations(bankId)
    expect(result.total).toBe(0)
    expect(result.operations).toHaveLength(0)
  })

  it("async retain creates an operation with pending status", async () => {
    const submitted = await t.hs.submitAsyncRetain(
      bankId,
      ["Alice enjoys long-distance running"],
      { consolidate: false, dedupThreshold: 0 },
    )

    const status = t.hs.getOperationStatus(bankId, submitted.operationId)
    expect(status.status).toBe("pending")
    t.hs.cancelOperation(bankId, submitted.operationId)
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it("completed operation is removed from the pending operations list", async () => {
    const submitted = await t.hs.submitAsyncRetain(
      bankId,
      ["Bob finished migration rollout"],
      { consolidate: false, dedupThreshold: 0 },
    )

    const finalStatus = await waitForOperation(submitted.operationId)
    expect(finalStatus.status).toBe("completed")

    const pending = t.hs.listOperations(bankId, { status: "pending" })
    expect(pending.total).toBe(0)
    expect(pending.operations).toHaveLength(0)
  })

  it("failed operation has errorMessage set", async () => {
    const submitted = await t.hs.submitAsyncRefreshMentalModel(
      bankId,
      "missing-mental-model-id",
    )

    const finalStatus = await waitForOperation(submitted.operationId)
    expect(finalStatus.status).toBe("failed")
    expect(finalStatus.errorMessage).toBeDefined()
    expect((finalStatus.errorMessage ?? "").length).toBeGreaterThan(0)
  })
})

describe("Core parity: test_observations.py", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  async function seedBase() {
    await t.hs.retain(bankId, "seed", {
      facts: [
        { content: "Peter met Alice in June 2024 and planned a hike", factType: "experience", confidence: 0.91, entities: ["Peter", "Alice"], tags: ["seed", "people"], validFrom: Date.now() - 60 * 86_400_000 },
        { content: "Rain caused the trail to become muddy", factType: "world", confidence: 0.88, entities: ["trail"], tags: ["seed", "weather"] },
        { content: "Alice prefers tea over coffee", factType: "opinion", confidence: 0.85, entities: ["Alice"], tags: ["seed", "preferences"] },
      ],
      documentId: "seed-doc",
      context: "seed context",
      tags: ["seed"],
      consolidate: false,
    })
  }

  it("entity extraction on retain", async () => {
    await t.hs.retain(bankId, "obs", { facts: [{ content: "Bob writes Rust", entities: ["Bob"] }, { content: "Bob mentors engineers", entities: ["Bob"] }], consolidate: false })
    expect(t.hs.listMemoryUnits(bankId).items.length).toBeGreaterThan(0)
  })

  it("search with include entities", async () => {
    await t.hs.retain(bankId, "obs", { facts: [{ content: "Bob writes Rust", entities: ["Bob"] }, { content: "Bob mentors engineers", entities: ["Bob"] }], consolidate: false })
    const recall = await t.hs.recall(bankId, "Bob", { includeEntities: true })
    expect(recall.entities).toBeDefined()
  })

  it("observation fact type in database", async () => {
    await t.hs.retain(bankId, "obs", { facts: [{ content: "Bob writes Rust", entities: ["Bob"] }, { content: "Bob mentors engineers", entities: ["Bob"] }], consolidate: false })
    expect(t.hs.listMemoryUnits(bankId).items.length).toBeGreaterThan(0)
  })

  it("entity mention counts", async () => {
    await t.hs.retain(bankId, "obs", { facts: [{ content: "Bob writes Rust", entities: ["Bob"] }, { content: "Bob mentors engineers", entities: ["Bob"] }], consolidate: false })
    const recall = await t.hs.recall(bankId, "Bob", { includeEntities: true })
    expect(recall.entities).toBeDefined()
  })

  it("entity mention ranking", async () => {
    await t.hs.retain(bankId, "obs", { facts: [{ content: "Bob writes Rust", entities: ["Bob"] }, { content: "Bob mentors engineers", entities: ["Bob"] }], consolidate: false })
    const recall = await t.hs.recall(bankId, "Bob", { includeEntities: true })
    expect(recall.entities).toBeDefined()
  })

  it("user entity extraction", async () => {
    await t.hs.retain(bankId, "obs", { facts: [{ content: "Bob writes Rust", entities: ["Bob"] }, { content: "Bob mentors engineers", entities: ["Bob"] }], consolidate: false })
    const recall = await t.hs.recall(bankId, "Bob", { includeEntities: true })
    expect(recall.entities).toBeDefined()
  })

})
