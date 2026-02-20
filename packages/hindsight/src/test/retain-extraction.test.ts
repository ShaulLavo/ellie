/**
 * Tests for fact extraction quality — emotional content, sensory details,
 * date conversion, speaker attribution, output ratio.
 *
 * Port of test_fact_extraction_quality.py + test_fact_extraction_output_ratio.py.
 * TDD targets — these require a real LLM and will fail with mock adapter.
 */

import { describe, it } from "bun:test"
import { implementMe } from "./setup"

describe("Fact extraction quality", () => {
  describe("emotional dimension preservation", () => {
    it("preserves 'thrilled' sentiment in extracted facts", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_emotional_thrilled",
      )
    })

    it("preserves 'disappointed' sentiment in extracted facts", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_emotional_disappointed",
      )
    })

    it("captures enthusiasm level from exclamation marks", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_emotional_enthusiasm",
      )
    })

    it("preserves mixed emotions (excitement and anxiety)", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_emotional_mixed",
      )
    })
  })

  describe("sensory dimension preservation", () => {
    it("captures taste descriptions (spicy, sweet)", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_sensory_taste",
      )
    })

    it("captures color descriptions (vibrant red, pale blue)", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_sensory_color",
      )
    })

    it("captures sound descriptions (loud, quiet, melodic)", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_sensory_sound",
      )
    })

    it("captures texture descriptions (smooth, rough)", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_sensory_texture",
      )
    })
  })

  describe("relative to absolute date conversion", () => {
    it("converts 'yesterday' to absolute date in extracted fact", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_date_yesterday",
      )
    })

    it("converts 'last Saturday' to absolute date", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_date_last_saturday",
      )
    })

    it("converts 'two weeks ago' to approximate date", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_date_two_weeks_ago",
      )
    })

    it("preserves absolute dates as-is", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_date_absolute_preserved",
      )
    })
  })

  describe("agent vs world classification", () => {
    it("classifies 'I went hiking' as experience", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_classify_experience",
      )
    })

    it("classifies 'Python is a programming language' as world", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_classify_world",
      )
    })

    it("classifies 'I think pizza is great' as opinion", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_classify_opinion",
      )
    })

    it("classifies 'The sunset was beautiful' as observation", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_classify_observation",
      )
    })
  })

  describe("speaker attribution", () => {
    it("attributes facts to the correct speaker in a conversation", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_speaker_attribution",
      )
    })

    it("resolves 'I' to the speaker's name when available", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_speaker_i_resolution",
      )
    })

    it("handles multi-speaker conversations", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_multi_speaker",
      )
    })
  })

  describe("irrelevant content filtering", () => {
    it("filters out 'How are you?' greetings", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_filter_greetings",
      )
    })

    it("filters out 'Thank you' responses", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_filter_thanks",
      )
    })

    it("filters out filler words and process chatter", () => {
      implementMe(
        "requires real LLM extraction",
        "test_fact_extraction_quality.py::test_filter_filler",
      )
    })
  })
})

describe("Fact extraction output ratio", () => {
  it("output/input token ratio stays below 5x", () => {
    implementMe(
      "requires real LLM extraction",
      "test_fact_extraction_output_ratio.py::test_ratio_below_5x",
    )
  })

  it("output/input token ratio stays below 6x for large inputs", () => {
    implementMe(
      "requires real LLM extraction",
      "test_fact_extraction_output_ratio.py::test_ratio_below_6x_large",
    )
  })

  it("extracts at least 1 fact from non-trivial input", () => {
    implementMe(
      "requires real LLM extraction",
      "test_fact_extraction_output_ratio.py::test_min_one_fact",
    )
  })

  it("returns empty array for trivial input", () => {
    implementMe(
      "requires real LLM extraction",
      "test_fact_extraction_output_ratio.py::test_trivial_empty",
    )
  })
})

describe("Fact extraction quality edge cases (TDD targets)", () => {
  it("multi-dimensional extraction: captures all quality dimensions in one pass (TDD)", () => {
    implementMe(
      "requires real LLM extraction",
      "test_fact_extraction_quality.py::test_comprehensive_multi_dimension",
    )
  })

  it("logical inference: 'I am Alice' → agent_name=Alice on all facts (TDD)", () => {
    implementMe(
      "requires real LLM extraction",
      "test_fact_extraction_quality.py::test_logical_inference_identity_connection",
    )
  })

  it("pronoun resolution: 'she said' resolved to named speaker (TDD)", () => {
    implementMe(
      "requires real LLM extraction",
      "test_fact_extraction_quality.py::test_logical_inference_pronoun_resolution",
    )
  })

  it("extraction without explicit context string still produces valid facts (TDD)", () => {
    implementMe(
      "requires real LLM extraction",
      "test_fact_extraction_quality.py::test_agent_facts_without_explicit_context",
    )
  })
})
