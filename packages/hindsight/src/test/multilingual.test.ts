/**
 * Tests for multilingual support — retain, recall, reflect in various languages.
 *
 * Port of test_multilingual.py.
 * Currently English-only. CJK and cross-language tests are marked .todo
 * until multilingual support is prioritized.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createTestHindsight, createTestBank, type TestHindsight } from './setup'

describe('Multilingual support', () => {
	// ── CJK support — not yet prioritized ──────────────────────────────────

	describe('Chinese content', () => {
		it.todo('retains Chinese text and extracts Chinese facts')
		it.todo('recalls Chinese content with Chinese query')
		it.todo('reflect responds in Chinese when memories are in Chinese')
		it.todo('preserves Chinese entity names')
	})

	describe('Japanese content', () => {
		it.todo('retains Japanese text and extracts Japanese facts')
		it.todo('recalls Japanese content')
		it.todo('handles kanji, hiragana, and katakana')
	})

	// ── Language preservation ──────────────────────────────────────────────

	describe('Language preservation', () => {
		let t: TestHindsight
		let bankId: string

		beforeEach(() => {
			t = createTestHindsight()
			bankId = createTestBank(t.hs)
		})

		afterEach(() => {
			t.cleanup()
		})

		it('English content stays in English (not translated to CJK)', async () => {
			const content = 'Yesterday I walked in the park and saw a beautiful sunset'

			const result = await t.hs.retain(bankId, 'test', {
				facts: [{ content }],
				consolidate: false
			})

			expect(result.memories).toHaveLength(1)
			// Verify the stored content is still English — not mangled or translated
			expect(result.memories[0]!.content).toBe(content)
		})

		it.todo('Italian content stays in Italian')
		it.todo('Mixed language entities are preserved correctly')
		it.todo('Extraction language matches input language')
	})

	// ── Cross-language retrieval — not yet prioritized ────────────────────

	describe('Cross-language retrieval', () => {
		it.todo('semantic search works across languages')
		it.todo('fulltext search handles CJK tokenization')
	})
})
