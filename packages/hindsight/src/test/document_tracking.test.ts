/**
 * Core parity port for test_document_tracking.py.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

describe("Core parity: test_document_tracking.py", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  async function _seedBase() {
    await t.hs.retain(bankId, "seed", {
      facts: [
        { content: "Peter met Alice in June 2024 and planned a hike", factType: "experience", confidence: 0.91, entities: ["Peter", "Alice"], tags: ["seed", "people"], occurredStart: Date.now() - 60 * 86_400_000 },
        { content: "Rain caused the trail to become muddy", factType: "world", confidence: 0.88, entities: ["trail"], tags: ["seed", "weather"] },
        { content: "Alice prefers tea over coffee", factType: "opinion", confidence: 0.85, entities: ["Alice"], tags: ["seed", "preferences"] },
      ],
      documentId: "seed-doc",
      context: "seed context",
      tags: ["seed"],
      consolidate: false,
    })
  }

  it("document creation and retrieval", async () => {
    await t.hs.retain(bankId, "doc", { facts: [{ content: "document-linked memory" }], documentId: "doc-a", consolidate: false })
    const doc = t.hs.getDocument(bankId, "doc-a")
    expect(doc).toBeDefined()
    expect(doc!.id).toBe("doc-a")
  })

  it("document upsert", async () => {
    await t.hs.retain(bankId, "doc", { facts: [{ content: "document-linked memory" }], documentId: "doc-a", metadata: { source: "test" }, consolidate: false })
    await t.hs.retain(bankId, "doc2", { facts: [{ content: "document-linked memory v2" }], documentId: "doc-a", metadata: { source: "test2" }, consolidate: false })
    const doc = t.hs.getDocument(bankId, "doc-a")
    expect(doc).toBeDefined()
    expect(doc!.updatedAt).toBeGreaterThanOrEqual(doc!.createdAt)
  })

  it("document deletion", async () => {
    await t.hs.retain(bankId, "doc", { facts: [{ content: "document-linked memory" }], documentId: "doc-a", consolidate: false })
    expect(t.hs.deleteDocument(bankId, "doc-a")).toBe(true)
  })

  it("memory without document", async () => {
    const result = await t.hs.retain(bankId, "plain", { facts: [{ content: "memory without document" }], consolidate: false })
    expect(result.memories[0]!.documentId).toBeNull()
  })

})
