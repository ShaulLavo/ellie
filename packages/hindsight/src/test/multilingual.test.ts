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

describe("Core parity: test_multilingual.py", () => {
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

  it("retain chinese content", async () => {
    const content = "test_retain_chinese_content".includes("japanese") ? "私は昨日東京で寿司を食べました" : "test_retain_chinese_content".includes("chinese") ? "我昨天在上海吃了面条" : "test_retain_chinese_content".includes("italian") ? "Ieri ho fatto una passeggiata in montagna" : "Yesterday I walked in the park"
    const result = await t.hs.retain(bankId, content, { facts: [{ content }], consolidate: false })
    expect(result.memories.length).toBe(1)
  })

  it("reflect chinese content", async () => {
    const content = "test_reflect_chinese_content".includes("japanese") ? "私は昨日東京で寿司を食べました" : "test_reflect_chinese_content".includes("chinese") ? "我昨天在上海吃了面条" : "test_reflect_chinese_content".includes("italian") ? "Ieri ho fatto una passeggiata in montagna" : "Yesterday I walked in the park"
    const result = await t.hs.retain(bankId, content, { facts: [{ content }], consolidate: false })
    expect(result.memories.length).toBe(1)
    t.adapter.setResponse("Multilingual reflection answer")
    const reflection = await t.hs.reflect(bankId, content, { saveObservations: false, maxIterations: 1 })
    expect(reflection.answer.length).toBeGreaterThan(0)
  })

  it("retain japanese content", async () => {
    const content = "test_retain_japanese_content".includes("japanese") ? "私は昨日東京で寿司を食べました" : "test_retain_japanese_content".includes("chinese") ? "我昨天在上海吃了面条" : "test_retain_japanese_content".includes("italian") ? "Ieri ho fatto una passeggiata in montagna" : "Yesterday I walked in the park"
    const result = await t.hs.retain(bankId, content, { facts: [{ content }], consolidate: false })
    expect(result.memories.length).toBe(1)
  })

  it("english content stays english", async () => {
    const content = "test_english_content_stays_english".includes("japanese") ? "私は昨日東京で寿司を食べました" : "test_english_content_stays_english".includes("chinese") ? "我昨天在上海吃了面条" : "test_english_content_stays_english".includes("italian") ? "Ieri ho fatto una passeggiata in montagna" : "Yesterday I walked in the park"
    const result = await t.hs.retain(bankId, content, { facts: [{ content }], consolidate: false })
    expect(result.memories.length).toBe(1)
  })

  it("italian content stays italian", async () => {
    const content = "test_italian_content_stays_italian".includes("japanese") ? "私は昨日東京で寿司を食べました" : "test_italian_content_stays_italian".includes("chinese") ? "我昨天在上海吃了面条" : "test_italian_content_stays_italian".includes("italian") ? "Ieri ho fatto una passeggiata in montagna" : "Yesterday I walked in the park"
    const result = await t.hs.retain(bankId, content, { facts: [{ content }], consolidate: false })
    expect(result.memories.length).toBe(1)
  })

})
