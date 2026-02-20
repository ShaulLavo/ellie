/**
 * Tests for multilingual support — retain, recall, reflect in various languages.
 *
 * Port of test_multilingual.py.
 * TDD targets — these require a real LLM for language-aware extraction.
 */

import { describe, it } from "bun:test"

describe("Multilingual support", () => {
  describe("Chinese content", () => {
    it.todo("retains Chinese text and extracts Chinese facts")
    it.todo("recalls Chinese content with Chinese query")
    it.todo("reflect responds in Chinese when memories are in Chinese")
    it.todo("preserves Chinese entity names")
  })

  describe("Japanese content", () => {
    it.todo("retains Japanese text and extracts Japanese facts")
    it.todo("recalls Japanese content")
    it.todo("handles kanji, hiragana, and katakana")
  })

  describe("Language preservation", () => {
    it.todo("English content stays in English (not translated to CJK)")
    it.todo("Italian content stays in Italian")
    it.todo("Mixed language entities are preserved correctly")
    it.todo("Extraction language matches input language")
  })

  describe("Cross-language retrieval", () => {
    it.todo("semantic search works across languages")
    it.todo("fulltext search handles CJK tokenization")
  })
})
