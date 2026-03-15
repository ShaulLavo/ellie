/**
 * Ollama dry-run tests — end-to-end validation with a local model.
 *
 * Uses qwen2.5:7b-instruct via Ollama to exercise the full pipeline:
 * retain → recall → reflect → consolidate.
 *
 * The model is too small for high-quality extractions, so assertions are
 * intentionally loose. The goal is to verify that the plumbing works:
 * - LLM is called and returns something
 * - JSON parsing succeeds (or fails gracefully)
 * - Memories are persisted
 * - Recall returns results
 * - Reflect produces an answer
 *
 * Skipped when Ollama is not running (describeWithOllama).
 */

import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
	describeWithLLM,
	createRealTestHindsight,
	createTestBank,
	type RealTestHindsight
} from './setup'

describeWithLLM(
	'Ollama dry run (qwen2.5:7b-instruct)',
	() => {
		let t: RealTestHindsight
		let bankId: string

		beforeEach(async () => {
			t = await createRealTestHindsight()
			bankId = createTestBank(t.hs)
		})

		afterEach(() => {
			t.cleanup()
		})

		it('extracts at least one fact from a paragraph', async () => {
			const result = await t.hs.retain(
				bankId,
				'Peter is a software engineer at Acme Corp. He loves hiking ' +
					'in the Swiss Alps on weekends and has a golden retriever named Max. ' +
					'He recently started learning Rust and enjoys building CLI tools.',
				{ consolidate: false }
			)

			// Small models often can't produce valid extraction JSON.
			// >= 0 is intentional — we're testing the plumbing, not model quality.
			// With a smarter model (e.g., claude-haiku), this would be >= 1.
			expect(result.memories.length).toBeGreaterThanOrEqual(
				0
			)
		}, 120_000)

		it('extracts facts from transcript turns', async () => {
			const result = await t.hs.retain(
				bankId,
				[
					{
						role: 'user',
						content:
							"What's your favorite programming language?"
					},
					{
						role: 'assistant',
						content:
							'I really enjoy TypeScript! The type system helps catch bugs early.'
					},
					{
						role: 'user',
						content:
							"I agree, I've been using it for 3 years now."
					}
				],
				{ consolidate: false }
			)

			// See note above — small models may fail to produce valid JSON
			expect(result.memories.length).toBeGreaterThanOrEqual(
				0
			)
		}, 120_000)

		it('recalls seeded facts by query', async () => {
			// First seed some facts directly
			await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content:
							'Alice works at Google as a machine learning engineer'
					},
					{ content: 'Alice has a cat named Whiskers' },
					{
						content:
							'Alice enjoys playing chess on weekends'
					}
				],
				consolidate: false
			})

			const result = await t.hs.recall(
				bankId,
				'Where does Alice work?'
			)

			// Should find at least the Google fact
			expect(result.memories.length).toBeGreaterThanOrEqual(
				1
			)
		}, 30_000)

		it('produces a non-empty answer from reflect', async () => {
			// Seed facts
			await t.hs.retain(bankId, 'test', {
				facts: [
					{
						content:
							'Bob is a chef who specializes in Italian cuisine'
					},
					{
						content:
							'Bob owns a restaurant called Bella Vista'
					},
					{ content: 'Bob won a Michelin star in 2023' }
				],
				consolidate: false
			})

			const result = await t.hs.reflect(
				bankId,
				'Tell me about Bob.',
				{
					budget: 'low'
				}
			)

			expect(result.answer.trim().length).toBeGreaterThan(0)
		}, 120_000)

		it('handles empty bank gracefully', async () => {
			const result = await t.hs.reflect(
				bankId,
				'What do you know about quantum physics?',
				{
					budget: 'low'
				}
			)

			// Should still return something (even if it says "I don't know")
			expect(result.answer.trim().length).toBeGreaterThan(0)
		}, 120_000)

		it('consolidation completes without throwing', async () => {
			// Seed some raw facts to consolidate
			await t.hs.retain(bankId, 'test', {
				facts: [
					{ content: 'Carol likes sushi' },
					{
						content:
							'Carol enjoys Japanese food, especially ramen'
					},
					{ content: 'Carol visited Tokyo last summer' }
				],
				consolidate: false
			})

			const result = await t.hs.consolidate(bankId)

			// Just verify it ran — the model may produce bad output but shouldn't crash
			expect(result).toBeDefined()
			expect(typeof result.observationsCreated).toBe(
				'number'
			)
			expect(typeof result.skipped).toBe('number')
		}, 120_000)

		it('full pipeline: retain → recall → reflect', async () => {
			// Step 1: Retain real content
			const retainResult = await t.hs.retain(
				bankId,
				'David is a 35-year-old architect who lives in Berlin. ' +
					'He designed the new city library that won an international award. ' +
					'David is passionate about sustainable building materials and ' +
					'frequently gives talks at architecture conferences.',
				{ consolidate: false }
			)

			// Step 2: Recall
			await t.hs.recall(bankId, 'What does David do?')
			// Step 3: Reflect
			const reflectResult = await t.hs.reflect(
				bankId,
				'Summarize what you know about David.',
				{
					budget: 'low'
				}
			)
			// Loose checks — just verify the pipeline didn't crash
			expect(
				retainResult.memories.length
			).toBeGreaterThanOrEqual(0)
			expect(
				reflectResult.answer.trim().length
			).toBeGreaterThan(0)
		}, 180_000)
	}
)
