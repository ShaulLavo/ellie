/**
 * Tests for multilingual support — retain, recall, reflect in various languages.
 *
 * Port of test_multilingual.py.
 * TDD targets — these require a real LLM for language-aware extraction.
 */

import { describe, it } from "bun:test"
import { implementMe } from "./setup"

describe("Multilingual support", () => {
  describe("Chinese content", () => {
    it("retains Chinese text and extracts Chinese facts", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_chinese_retain",
      )
    })

    it("recalls Chinese content with Chinese query", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_chinese_recall",
      )
    })

    it("reflect responds in Chinese when memories are in Chinese", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_chinese_reflect",
      )
    })

    it("preserves Chinese entity names", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_chinese_entities",
      )
    })
  })

  describe("Japanese content", () => {
    it("retains Japanese text and extracts Japanese facts", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_japanese_retain",
      )
    })

    it("recalls Japanese content", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_japanese_recall",
      )
    })

    it("handles kanji, hiragana, and katakana", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_japanese_scripts",
      )
    })
  })

  describe("Language preservation", () => {
    it("English content stays in English (not translated to CJK)", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_english_preservation",
      )
    })

    it("Italian content stays in Italian", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_italian_preservation",
      )
    })

    it("Mixed language entities are preserved correctly", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_mixed_language_entities",
      )
    })

    it("Extraction language matches input language", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_extraction_language_match",
      )
    })
  })

  describe("Cross-language retrieval", () => {
    it("semantic search works across languages", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_cross_language_semantic",
      )
    })

    it("fulltext search handles CJK tokenization", () => {
      implementMe(
        "requires real LLM for multilingual extraction",
        "test_multilingual.py::test_cjk_tokenization",
      )
    })
  })
})
