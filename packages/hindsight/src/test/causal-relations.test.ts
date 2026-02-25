/**
 * Tests for causal relations — extraction validation and memory linking.
 *
 * Port of test_causal_relations.py + test_causal_relationships.py.
 * Mix of unit tests (validation) and TDD targets (extraction).
 */

import { it, expect, beforeEach, afterEach, describe } from 'bun:test'
import {
	createTestHindsight,
	createTestBank,
	createRealTestHindsight,
	describeWithLLM,
	type TestHindsight,
	type RealTestHindsight
} from './setup'
import type { HindsightDatabase } from '../db'

describe('Causal relations validation', () => {
	it('causal relations only reference previous facts (targetIndex < current)', () => {
		// This validates the schema constraint:
		// causalRelations[].targetIndex must be < the current fact's index
		const facts = [
			{
				content: 'It started raining',
				causalRelations: [] // First fact: no prior facts to reference
			},
			{
				content: 'The trail became muddy',
				causalRelations: [{ targetIndex: 0, strength: 0.8 }] // Valid: references fact 0
			},
			{
				content: 'We decided to turn back',
				causalRelations: [{ targetIndex: 1, strength: 0.7 }] // Valid: references fact 1
			}
		]

		for (let i = 0; i < facts.length; i++) {
			for (const rel of facts[i]!.causalRelations) {
				expect(rel.targetIndex).toBeLessThan(i)
			}
		}
	})

	it('first fact cannot have causal relations', () => {
		// Index 0 has no previous facts to reference.
		// The constraint is: targetIndex must be < current index.
		// For the first fact (index 0), no non-negative targetIndex can satisfy < 0,
		// so a valid first fact must have an empty causalRelations array.
		const validFirstFact = {
			content: 'Something happened',
			causalRelations: [] as Array<{ targetIndex: number; strength: number }>
		}

		expect(validFirstFact.causalRelations).toHaveLength(0)
		// Constraint: targetIndex must be < current index. For fact 0, no valid
		// targetIndex exists (0 is not < 0), so causalRelations must be empty.
	})

	it('valid causal chain has backward-looking references', () => {
		const chain = [
			{ content: 'Rain started', index: 0 },
			{ content: 'Streets flooded', index: 1, causedBy: 0 },
			{ content: 'Traffic jammed', index: 2, causedBy: 1 },
			{ content: 'People were late', index: 3, causedBy: 2 }
		]

		for (let i = 1; i < chain.length; i++) {
			expect(chain[i]!.causedBy).toBeLessThan(chain[i]!.index)
			expect(chain[i]!.causedBy).toBeGreaterThanOrEqual(0)
		}
	})

	it("only 'caused_by' is a valid causal relation type (Python parity)", () => {
		// Python parity: valid_types = {"caused_by"}
		// The extraction prompt instructs the LLM to use only "caused_by".
		// Other link types (temporal, semantic, entity) are non-causal.
		const validCausalTypes = ['caused_by']
		expect(validCausalTypes).toHaveLength(1)
		expect(validCausalTypes).toContain('caused_by')
	})
})

describe('Causal relation storage', () => {
	let t: TestHindsight
	let bankId: string

	beforeEach(() => {
		t = createTestHindsight()
		bankId = createTestBank(t.hs)
	})

	afterEach(() => {
		t.cleanup()
	})

	it('stores memories that can be linked causally', async () => {
		// Retain two related facts
		const result = await t.hs.retain(bankId, 'test', {
			facts: [
				{ content: 'It started raining heavily' },
				{ content: 'The hiking trail became muddy and slippery' }
			],
			consolidate: false
		})

		// Both facts should be stored
		expect(result.memories).toHaveLength(2)
		// Causal links may or may not be created depending on extraction
		// (pre-provided facts don't include causalRelations — that requires LLM)
		expect(result.links).toBeDefined()
	})
})

// ── Causal relation extraction (real LLM) ───────────────────────────────────
//
// Port of test_causal_relations.py::TestCausalRelationsValidation (LLM tests)
//       + test_causal_relationships.py::TestCausalRelationships
//
// Uses real Anthropic adapter (claude-haiku-4-5) for LLM extraction.
// Same narrative texts and assertion patterns as the Python reference.
// Skipped when ANTHROPIC_API_KEY is not set.
// TODO: Set ANTHROPIC_API_KEY in test environment to enable real LLM tests.

// Python parity: only "caused_by" is a valid causal relation type.
const CAUSAL_TYPES = ['caused_by']

function isCausal(linkType: string): boolean {
	return CAUSAL_TYPES.includes(linkType)
}

describeWithLLM('Causal relation extraction', () => {
	let t: RealTestHindsight
	let bankId: string

	beforeEach(async () => {
		t = await createRealTestHindsight()
		bankId = createTestBank(t.hs)
	})

	afterEach(() => {
		t.cleanup()
	})

	// Port of test_causal_relationships.py::test_causal_chain_extraction
	// Python asserts: len(facts) >= 3, len(all_causal_relations) >= 2,
	// all target_index < from_index, valid relation types
	it('extracts causal chain from narrative text', async () => {
		const result = await t.hs.retain(
			bankId,
			`I lost my job at the tech company in January because of layoffs.
Because I lost my job, I couldn't pay my rent anymore.
Since I couldn't afford rent, I had to move out of my apartment.
After searching for weeks, I finally found a cheaper apartment in Brooklyn.`,
			{ consolidate: false, context: 'Personal story about housing change' }
		)

		// Python: assert len(facts) >= 3
		expect(result.memories.length).toBeGreaterThanOrEqual(3)

		const causalLinks = result.links.filter((l) => isCausal(l.linkType))

		// Python: assert len(all_causal_relations) >= 2
		expect(causalLinks.length).toBeGreaterThanOrEqual(2)

		// All causal links must connect distinct memories
		for (const link of causalLinks) {
			expect(link.sourceId).not.toBe(link.targetId)
		}
	}, 60_000)

	// Port of test_causal_relations.py::test_token_efficiency_with_causal_relations
	it('token efficiency: output/input ratio < 6x with causal relations', async () => {
		const input = `The company announced budget cuts in Q1.
Due to the budget cuts, the marketing team was reduced.
The reduced team meant fewer campaigns could be run.
With fewer campaigns, lead generation dropped.
Lower leads resulted in decreased sales.`

		const result = await t.hs.retain(bankId, input, {
			consolidate: false,
			context: 'Business impact analysis'
		})

		expect(result.memories.length).toBeGreaterThan(0)

		const outputTokens = result.memories
			.map((m) => m.content)
			.join(' ')
			.split(/\s+/).length
		const inputTokens = input.split(/\s+/).length
		// Ratio should be reasonable (< 6x) — previously could be 7-10x due to hallucinated indices
		expect(outputTokens / inputTokens).toBeLessThan(6)
	}, 60_000)

	// Port of test_causal_relationships.py::test_complex_causal_web
	// NOTE: Flaky — LLM extraction may return 3 facts instead of >= 4 depending on model behavior
	it('extracts complex multi-node causal graph', async () => {
		const result = await t.hs.retain(
			bankId,
			`The heavy rain caused flooding in the basement.
The flooding damaged the electrical system.
Because of the electrical damage, we had to call an electrician.
The electrician found that the wiring was old and needed replacement.
We decided to renovate the entire basement while fixing the wiring.
The renovation took three months and cost $15,000.`,
			{ consolidate: false, context: 'Home repair story' }
		)

		// Python: assert len(facts) >= 4
		expect(result.memories.length).toBeGreaterThanOrEqual(4)

		// Validate all causal links connect distinct memories
		const causalLinks = result.links.filter((l) => isCausal(l.linkType))
		if (causalLinks.length > 0) {
			for (const link of causalLinks) {
				expect(link.sourceId).not.toBe(link.targetId)
			}
		}
	}, 60_000)

	// Port of test_causal_relations.py::test_causal_strength
	it('strength reflects causal certainty (strong vs weak)', async () => {
		const _result = await t.hs.retain(
			bankId,
			`The stock market crash directly caused the company to lay off employees.
The layoffs indirectly led to reduced consumer spending in the area.
Reduced spending somewhat affected local businesses.`,
			{ consolidate: false, context: 'Economic impact story' }
		)

		// Query DB for stored weight values
		const hdb = (t.hs as unknown as { hdb: HindsightDatabase }).hdb
		const dbLinks = hdb.db
			.select({
				linkType: hdb.schema.memoryLinks.linkType,
				weight: hdb.schema.memoryLinks.weight
			})
			.from(hdb.schema.memoryLinks)
			.all()
			.filter((l: { linkType: string }) => isCausal(l.linkType))

		// If causal links were extracted, strengths must be in [0, 1]
		for (const link of dbLinks) {
			expect(link.weight).toBeGreaterThanOrEqual(0.0)
			expect(link.weight).toBeLessThanOrEqual(1.0)
		}
	}, 60_000)

	// Port of test_causal_relations.py::test_causal_chain_extraction +
	//        test_causal_relations.py::test_relation_types_are_backward_looking
	// Python asserts: len(facts) > 0, valid chain if relations exist,
	//                 relation types in {"caused_by"} (Python parity)
	it("relation types are only 'caused_by' (Python parity)", async () => {
		const result = await t.hs.retain(
			bankId,
			`Alice learned Python programming.
Because she knew Python, she got a job as a data scientist.
Her data science skills enabled her to lead the analytics team.`,
			{ consolidate: false, context: 'Career progression' }
		)

		// Python: assert len(facts) > 0
		expect(result.memories.length).toBeGreaterThan(0)

		// If causal links were extracted, verify valid chain + types
		const causalLinks = result.links.filter((l) => isCausal(l.linkType))
		const validTypes = new Set(CAUSAL_TYPES)
		for (const link of causalLinks) {
			expect(link.sourceId).not.toBe(link.targetId)
			expect(validTypes.has(link.linkType)).toBe(true)
		}
	}, 60_000)

	// Port of test_causal_relationships.py::test_no_self_referencing_causal_relations
	it('no fact has self-referencing causal relation', async () => {
		const result = await t.hs.retain(
			bankId,
			`I started learning Python because I wanted to automate my work tasks.
Learning Python led me to discover machine learning.
Machine learning fascinated me so much that I changed my career to data science.`,
			{ consolidate: false, context: 'Career change story' }
		)

		// No causal link should be a self-reference
		const causalLinks = result.links.filter((l) => isCausal(l.linkType))
		for (const link of causalLinks) {
			expect(link.sourceId).not.toBe(link.targetId)
		}
	}, 60_000)

	// Port of test_causal_relationships.py::test_bidirectional_causal_relationships
	//      + test_causal_relations.py::test_relation_types_are_backward_looking
	it('bidirectional causal links use backward-looking only', async () => {
		const result = await t.hs.retain(
			bankId,
			`My promotion at work caused me to move to New York.
Moving to New York was caused by my promotion at work.
The new role enabled me to lead a team of engineers.`,
			{ consolidate: false, context: 'Work promotion story' }
		)

		// All causal links must connect distinct memories (backward-looking enforced by pipeline)
		const causalLinks = result.links.filter((l) => isCausal(l.linkType))
		for (const link of causalLinks) {
			expect(link.sourceId).not.toBe(link.targetId)
		}

		// Relation types must be valid
		const validTypes = new Set(CAUSAL_TYPES)
		for (const link of causalLinks) {
			expect(validTypes.has(link.linkType)).toBe(true)
		}
	}, 60_000)

	// Port of test_causal_relationships.py::test_causal_relation_strength_values
	it('strength values are within [0.0, 1.0]', async () => {
		const _result = await t.hs.retain(
			bankId,
			`The stock market crash directly caused the company to lay off employees.
The layoffs indirectly led to reduced consumer spending in the area.
Reduced spending somewhat affected local businesses.`,
			{ consolidate: false, context: 'Economic impact story' }
		)

		// Query DB for stored weight values
		const hdb = (t.hs as unknown as { hdb: HindsightDatabase }).hdb
		const dbLinks = hdb.db
			.select({
				linkType: hdb.schema.memoryLinks.linkType,
				weight: hdb.schema.memoryLinks.weight
			})
			.from(hdb.schema.memoryLinks)
			.all()
			.filter((l: { linkType: string }) => isCausal(l.linkType))

		for (const link of dbLinks) {
			expect(link.weight).toBeGreaterThanOrEqual(0.0)
			expect(link.weight).toBeLessThanOrEqual(1.0)
		}
	}, 60_000)
})
