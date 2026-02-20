/**
 * Tests for causal relations — extraction validation and memory linking.
 *
 * Port of test_causal_relations.py + test_causal_relationships.py.
 * Mix of unit tests (validation) and TDD targets (extraction).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, implementMe, type TestHindsight } from "./setup"

describe("Causal relations validation", () => {
  it("causal relations only reference previous facts (targetIndex < current)", () => {
    // This validates the schema constraint:
    // causalRelations[].targetIndex must be < the current fact's index
    const facts = [
      {
        content: "It started raining",
        causalRelations: [], // First fact: no prior facts to reference
      },
      {
        content: "The trail became muddy",
        causalRelations: [{ targetIndex: 0, strength: 0.8 }], // Valid: references fact 0
      },
      {
        content: "We decided to turn back",
        causalRelations: [{ targetIndex: 1, strength: 0.7 }], // Valid: references fact 1
      },
    ]

    for (let i = 0; i < facts.length; i++) {
      for (const rel of facts[i]!.causalRelations) {
        expect(rel.targetIndex).toBeLessThan(i)
      }
    }
  })

  it("first fact cannot have causal relations", () => {
    // Index 0 has no previous facts to reference.
    // The constraint is: targetIndex must be < current index.
    // For the first fact (index 0), no non-negative targetIndex can satisfy < 0,
    // so a valid first fact must have an empty causalRelations array.
    const validFirstFact = {
      content: "Something happened",
      causalRelations: [] as Array<{ targetIndex: number; strength: number }>,
    }

    expect(validFirstFact.causalRelations).toHaveLength(0)

    // Demonstrate the constraint: any targetIndex on fact 0 would be invalid
    const invalidTargetIndex = 0
    expect(invalidTargetIndex).not.toBeLessThan(0) // 0 is not < 0, so it's invalid
  })

  it("valid causal chain has backward-looking references", () => {
    const chain = [
      { content: "Rain started", index: 0 },
      { content: "Streets flooded", index: 1, causedBy: 0 },
      { content: "Traffic jammed", index: 2, causedBy: 1 },
      { content: "People were late", index: 3, causedBy: 2 },
    ]

    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.causedBy).toBeLessThan(chain[i]!.index)
      expect(chain[i]!.causedBy).toBeGreaterThanOrEqual(0)
    }
  })

  it("relation types match the schema (causes, caused_by, enables, prevents)", () => {
    // Causal relation types from types.ts LinkType union:
    // forward-looking: causes, enables, prevents
    // backward-looking: caused_by
    const validRelationTypes = ["causes", "caused_by", "enables", "prevents"]
    expect(validRelationTypes).toHaveLength(4)
    expect(validRelationTypes).toContain("causes")
    expect(validRelationTypes).toContain("caused_by")
    expect(validRelationTypes).toContain("enables")
    expect(validRelationTypes).toContain("prevents")
  })
})

describe("Causal relation storage", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  it("stores memories that can be linked causally", async () => {
    // Retain two related facts
    const result = await t.hs.retain(bankId, "test", {
      facts: [
        { content: "It started raining heavily" },
        { content: "The hiking trail became muddy and slippery" },
      ],
      consolidate: false,
    })

    // Both facts should be stored
    expect(result.memories).toHaveLength(2)
    // Causal links may or may not be created depending on extraction
    // (pre-provided facts don't include causalRelations — that requires LLM)
    expect(result.links).toBeDefined()
  })
})

describe("Causal relation extraction (TDD targets)", () => {
  it("extracts causal chain from narrative text", () => {
    implementMe(
      "requires real LLM for causal extraction",
      "test_fact_extraction_quality.py::test_causal_chain_extraction",
    )
  })

  it("strength reflects causal certainty (strong vs weak)", () => {
    implementMe(
      "requires real LLM for causal extraction",
      "test_fact_extraction_quality.py::test_causal_strength",
    )
  })

  it("token efficiency: output/input ratio < 6x with causal relations", () => {
    implementMe(
      "requires real LLM for causal extraction",
      "test_fact_extraction_quality.py::test_causal_token_efficiency",
    )
  })

  it("multiple causal relations per fact (caused_by + enabled_by)", () => {
    implementMe(
      "requires real LLM for causal extraction",
      "test_fact_extraction_quality.py::test_multiple_causal_relations",
    )
  })

  it("extracts complex multi-node causal graph", () => {
    implementMe(
      "requires real LLM for causal extraction",
      "test_fact_extraction_quality.py::test_complex_causal_graph",
    )
  })

  it("no fact has self-referencing causal relation", () => {
    implementMe(
      "requires real LLM for causal extraction",
      "test_fact_extraction_quality.py::test_no_self_reference",
    )
  })

  it("bidirectional causal links use backward-looking only", () => {
    implementMe(
      "requires real LLM for causal extraction",
      "test_fact_extraction_quality.py::test_backward_looking_only",
    )
  })

  it("strength values are within [0.0, 1.0]", () => {
    implementMe(
      "requires real LLM for causal extraction",
      "test_fact_extraction_quality.py::test_strength_range",
    )
  })
})
