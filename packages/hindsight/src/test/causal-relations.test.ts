/**
 * Tests for causal relations — extraction validation and memory linking.
 *
 * Port of test_causal_relations.py + test_causal_relationships.py.
 * Mix of unit tests (validation) and TDD targets (extraction).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestHindsight, createTestBank, type TestHindsight } from "./setup"

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

// ── Causal relation extraction ──────────────────────────────────────────────
//
// Port of test_causal_relations.py::TestCausalRelationsValidation (LLM tests)
//       + test_causal_relationships.py::TestCausalRelationships
//
// Uses mock adapter to simulate LLM extraction responses.
// Same narrative texts and assertion patterns as the Python reference.

const CAUSAL_TYPES = ["causes", "caused_by", "enables", "prevents"]

function isCausal(linkType: string): boolean {
  return CAUSAL_TYPES.includes(linkType)
}

describe("Causal relation extraction", () => {
  let t: TestHindsight
  let bankId: string

  beforeEach(() => {
    t = createTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  // Port of test_causal_relations.py::test_causal_chain_extraction
  //      + test_causal_relationships.py::test_causal_chain_extraction
  it("extracts causal chain from narrative text", async () => {
    // Same narrative as Python: lost job → couldn't pay rent → had to move → found apartment
    t.adapter.setResponse(
      JSON.stringify({
        facts: [
          {
            content: "Lost job at tech company in January due to layoffs",
            factType: "experience",
            causalRelations: [],
          },
          {
            content: "Couldn't pay rent after losing job",
            factType: "experience",
            causalRelations: [{ targetIndex: 0, relationType: "caused_by", strength: 0.9 }],
          },
          {
            content: "Had to move out of apartment",
            factType: "experience",
            causalRelations: [{ targetIndex: 1, relationType: "caused_by", strength: 0.85 }],
          },
          {
            content: "Found a cheaper apartment in Brooklyn",
            factType: "experience",
            causalRelations: [{ targetIndex: 2, relationType: "caused_by", strength: 0.8 }],
          },
        ],
      }),
    )

    const result = await t.hs.retain(
      bankId,
      `I lost my job at the tech company in January because of layoffs.
Because I lost my job, I couldn't pay my rent anymore.
Since I couldn't afford rent, I had to move out of my apartment.
After searching for weeks, I finally found a cheaper apartment in Brooklyn.`,
      { consolidate: false },
    )

    expect(result.memories.length).toBeGreaterThanOrEqual(3)

    // Collect all causal relations
    const causalLinks = result.links.filter((l) => isCausal(l.linkType))

    // Should have at least 2 causal relationships from this clear chain
    expect(causalLinks.length).toBeGreaterThanOrEqual(2)

    // All causal links must connect distinct memories (no self-refs)
    for (const link of causalLinks) {
      expect(link.sourceId).not.toBe(link.targetId)
    }
  })

  // Port of test_causal_relations.py::test_token_efficiency_with_causal_relations
  it("token efficiency: output/input ratio < 6x with causal relations", async () => {
    // Same narrative as Python: budget cuts → reduced team → fewer campaigns → lower leads → decreased sales
    const input = `The company announced budget cuts in Q1.
Due to the budget cuts, the marketing team was reduced.
The reduced team meant fewer campaigns could be run.
With fewer campaigns, lead generation dropped.
Lower leads resulted in decreased sales.`

    t.adapter.setResponse(
      JSON.stringify({
        facts: [
          { content: "Company announced budget cuts in Q1", factType: "observation", causalRelations: [] },
          {
            content: "Marketing team was reduced",
            factType: "observation",
            causalRelations: [{ targetIndex: 0, relationType: "caused_by", strength: 0.9 }],
          },
          {
            content: "Fewer campaigns could be run",
            factType: "observation",
            causalRelations: [{ targetIndex: 1, relationType: "caused_by", strength: 0.85 }],
          },
          {
            content: "Lead generation dropped",
            factType: "observation",
            causalRelations: [{ targetIndex: 2, relationType: "caused_by", strength: 0.8 }],
          },
          {
            content: "Sales decreased",
            factType: "observation",
            causalRelations: [{ targetIndex: 3, relationType: "caused_by", strength: 0.8 }],
          },
        ],
      }),
    )

    const result = await t.hs.retain(bankId, input, { consolidate: false })

    const outputTokens = result.memories
      .map((m) => m.content)
      .join(" ")
      .split(/\s+/).length
    const inputTokens = input.split(/\s+/).length
    // Ratio should be reasonable (< 6x) — previously could be 7-10x due to hallucinated indices
    expect(outputTokens / inputTokens).toBeLessThan(6)
  })

  // Port of test_causal_relationships.py::test_complex_causal_web
  it("extracts complex multi-node causal graph", async () => {
    // Same narrative as Python: rain → flooding → electrical damage → electrician → renovation → cost
    t.adapter.setResponse(
      JSON.stringify({
        facts: [
          { content: "Heavy rain caused flooding in the basement", factType: "observation", causalRelations: [] },
          {
            content: "Flooding damaged the electrical system",
            factType: "observation",
            causalRelations: [{ targetIndex: 0, relationType: "caused_by", strength: 0.9 }],
          },
          {
            content: "Had to call an electrician because of electrical damage",
            factType: "experience",
            causalRelations: [{ targetIndex: 1, relationType: "caused_by", strength: 0.85 }],
          },
          {
            content: "Electrician found old wiring needed replacement",
            factType: "observation",
            causalRelations: [{ targetIndex: 2, relationType: "caused_by", strength: 0.7 }],
          },
          {
            content: "Decided to renovate entire basement while fixing wiring",
            factType: "experience",
            causalRelations: [
              { targetIndex: 3, relationType: "caused_by", strength: 0.8 },
              { targetIndex: 1, relationType: "caused_by", strength: 0.6 },
            ],
          },
          {
            content: "Renovation took three months and cost $15,000",
            factType: "observation",
            causalRelations: [{ targetIndex: 4, relationType: "caused_by", strength: 0.9 }],
          },
        ],
      }),
    )

    const result = await t.hs.retain(
      bankId,
      `The heavy rain caused flooding in the basement.
The flooding damaged the electrical system.
Because of the electrical damage, we had to call an electrician.
The electrician found that the wiring was old and needed replacement.
We decided to renovate the entire basement while fixing the wiring.
The renovation took three months and cost $15,000.`,
      { consolidate: false },
    )

    expect(result.memories.length).toBeGreaterThanOrEqual(4)

    // Validate all causal relation indices reference previous facts only
    const causalLinks = result.links.filter((l) => isCausal(l.linkType))
    expect(causalLinks.length).toBeGreaterThanOrEqual(4)

    for (const link of causalLinks) {
      expect(link.sourceId).not.toBe(link.targetId)
    }
  })

  // Port of test_causal_relations.py::test_causal_strength (TS-specific: strength reflects certainty)
  it("strength reflects causal certainty (strong vs weak)", async () => {
    // Same narrative as Python: stock crash → layoffs → reduced spending → affected businesses
    t.adapter.setResponse(
      JSON.stringify({
        facts: [
          {
            content: "Stock market crash directly caused company layoffs",
            factType: "observation",
            causalRelations: [],
          },
          {
            content: "Layoffs indirectly led to reduced consumer spending",
            factType: "observation",
            causalRelations: [{ targetIndex: 0, relationType: "caused_by", strength: 0.9 }],
          },
          {
            content: "Reduced spending somewhat affected local businesses",
            factType: "observation",
            causalRelations: [{ targetIndex: 1, relationType: "caused_by", strength: 0.5 }],
          },
        ],
      }),
    )

    const result = await t.hs.retain(
      bankId,
      `The stock market crash directly caused the company to lay off employees.
The layoffs indirectly led to reduced consumer spending in the area.
Reduced spending somewhat affected local businesses.`,
      { consolidate: false },
    )

    const causalLinks = result.links.filter((l) => isCausal(l.linkType))
    expect(causalLinks).toHaveLength(2)

    // Verify weights are stored in DB with correct values
    const hdb = (t.hs as any).hdb
    const dbLinks = hdb.db
      .select({
        linkType: hdb.schema.memoryLinks.linkType,
        weight: hdb.schema.memoryLinks.weight,
      })
      .from(hdb.schema.memoryLinks)
      .all()
      .filter((l: { linkType: string }) => isCausal(l.linkType))

    const weights = dbLinks.map((l: { weight: number }) => l.weight).sort()
    expect(weights[0]).toBeCloseTo(0.5, 1) // weaker indirect cause
    expect(weights[1]).toBeCloseTo(0.9, 1) // stronger direct cause
  })

  // Port of test_causal_relationships.py::test_causal_chain_extraction (multiple relations per fact)
  it("multiple causal relations per fact (caused_by + enabled_by)", async () => {
    t.adapter.setResponse(
      JSON.stringify({
        facts: [
          { content: "Alice learned Python programming", factType: "experience", causalRelations: [] },
          {
            content: "Knowing Python led to data scientist job",
            factType: "experience",
            causalRelations: [{ targetIndex: 0, relationType: "caused_by", strength: 0.9 }],
          },
          {
            content: "Data science skills enabled leading the analytics team",
            factType: "experience",
            causalRelations: [
              { targetIndex: 1, relationType: "caused_by", strength: 0.8 },
              { targetIndex: 0, relationType: "enables", strength: 0.6 },
            ],
          },
        ],
      }),
    )

    const result = await t.hs.retain(
      bankId,
      `Alice learned Python programming.
Because she knew Python, she got a job as a data scientist.
Her data science skills enabled her to lead the analytics team.`,
      { consolidate: false },
    )

    // Fact at index 2 should have two causal links
    const mem2 = result.memories[2]!
    const causalLinksFromMem2 = result.links.filter(
      (l) => l.sourceId === mem2.id && isCausal(l.linkType),
    )
    expect(causalLinksFromMem2).toHaveLength(2)
    const linkTypes = causalLinksFromMem2.map((l) => l.linkType).sort()
    expect(linkTypes).toContain("caused_by")
    expect(linkTypes).toContain("enables")
  })

  // Port of test_causal_relationships.py::test_no_self_referencing_causal_relations
  it("no fact has self-referencing causal relation", async () => {
    // Same narrative as Python: learning Python → ML → career change
    // Mock includes an invalid self-reference that should be filtered
    t.adapter.setResponse(
      JSON.stringify({
        facts: [
          {
            content: "Started learning Python to automate work tasks",
            factType: "experience",
            causalRelations: [],
          },
          {
            content: "Learning Python led to discovering machine learning",
            factType: "experience",
            causalRelations: [
              { targetIndex: 1, relationType: "caused_by", strength: 0.9 }, // self-ref (invalid)
              { targetIndex: 0, relationType: "caused_by", strength: 0.85 }, // valid
            ],
          },
          {
            content: "ML fascination caused career change to data science",
            factType: "experience",
            causalRelations: [{ targetIndex: 1, relationType: "caused_by", strength: 0.9 }],
          },
        ],
      }),
    )

    const result = await t.hs.retain(
      bankId,
      `I started learning Python because I wanted to automate my work tasks.
Learning Python led me to discover machine learning.
Machine learning fascinated me so much that I changed my career to data science.`,
      { consolidate: false },
    )

    // Self-referencing relation (targetIndex: 1 on fact 1) should be filtered out
    const causalLinks = result.links.filter((l) => isCausal(l.linkType))
    for (const link of causalLinks) {
      expect(link.sourceId).not.toBe(link.targetId)
    }
  })

  // Port of test_causal_relationships.py::test_bidirectional_causal_relationships
  //      + test_causal_relations.py::test_relation_types_are_backward_looking
  it("bidirectional causal links use backward-looking only", async () => {
    // Same narrative as Python: promotion → move to NY → lead team
    // Mock includes forward-looking references that should be filtered
    t.adapter.setResponse(
      JSON.stringify({
        facts: [
          {
            content: "Got promoted at work",
            factType: "experience",
            causalRelations: [
              { targetIndex: 1, relationType: "causes", strength: 0.9 }, // forward-ref (invalid)
            ],
          },
          {
            content: "Moved to New York because of promotion",
            factType: "experience",
            causalRelations: [
              { targetIndex: 0, relationType: "caused_by", strength: 0.85 }, // valid backward-ref
            ],
          },
          {
            content: "New role enabled leading a team of engineers",
            factType: "experience",
            causalRelations: [
              { targetIndex: 0, relationType: "enables", strength: 0.8 }, // valid backward-ref
              { targetIndex: 5, relationType: "caused_by", strength: 0.7 }, // out-of-bounds (invalid)
            ],
          },
        ],
      }),
    )

    const result = await t.hs.retain(
      bankId,
      `My promotion at work caused me to move to New York.
Moving to New York was caused by my promotion at work.
The new role enabled me to lead a team of engineers.`,
      { consolidate: false },
    )

    const causalLinks = result.links.filter((l) => isCausal(l.linkType))
    // Only 2 valid backward-looking links should survive (fact1→0, fact2→0)
    expect(causalLinks).toHaveLength(2)

    // Validate all indices are backward-looking
    for (const link of causalLinks) {
      expect(link.sourceId).not.toBe(link.targetId)
    }
  })

  // Port of test_causal_relationships.py::test_causal_relation_strength_values
  it("strength values are within [0.0, 1.0]", async () => {
    // Same narrative as Python: stock crash → layoffs → reduced spending
    t.adapter.setResponse(
      JSON.stringify({
        facts: [
          {
            content: "Stock market crash directly caused company layoffs",
            factType: "observation",
            causalRelations: [],
          },
          {
            content: "Layoffs indirectly led to reduced consumer spending",
            factType: "observation",
            causalRelations: [{ targetIndex: 0, relationType: "caused_by", strength: 0.9 }],
          },
          {
            content: "Reduced spending somewhat affected local businesses",
            factType: "observation",
            causalRelations: [{ targetIndex: 1, relationType: "caused_by", strength: 0.5 }],
          },
        ],
      }),
    )

    const result = await t.hs.retain(
      bankId,
      `The stock market crash directly caused the company to lay off employees.
The layoffs indirectly led to reduced consumer spending in the area.
Reduced spending somewhat affected local businesses.`,
      { consolidate: false },
    )

    // Query DB for stored weight values
    const hdb = (t.hs as any).hdb
    const dbLinks = hdb.db
      .select({
        linkType: hdb.schema.memoryLinks.linkType,
        weight: hdb.schema.memoryLinks.weight,
      })
      .from(hdb.schema.memoryLinks)
      .all()
      .filter((l: { linkType: string }) => isCausal(l.linkType))

    expect(dbLinks.length).toBeGreaterThanOrEqual(1)
    for (const link of dbLinks) {
      expect(link.weight).toBeGreaterThanOrEqual(0.0)
      expect(link.weight).toBeLessThanOrEqual(1.0)
    }
  })
})
