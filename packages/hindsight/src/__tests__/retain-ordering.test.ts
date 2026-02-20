/**
 * Tests for fact ordering — temporal ordering within documents.
 *
 * Port of test_fact_ordering.py.
 * TDD targets — these require real LLM extraction.
 */

import { describe, it } from "bun:test"
import { implementMe } from "./setup"

describe("Fact ordering", () => {
  describe("temporal ordering within a conversation", () => {
    it("facts from same conversation maintain temporal order via mentionedAt", () => {
      implementMe(
        "requires mentionedAt offset from LLM extraction",
        "test_fact_ordering.py::test_temporal_order_same_conversation",
      )
    })

    it("later facts have higher mentionedAt than earlier facts", () => {
      implementMe(
        "requires mentionedAt offset from LLM extraction",
        "test_fact_ordering.py::test_later_facts_higher_mentioned_at",
      )
    })

    it("first fact has mentionedAt close to event_date", () => {
      implementMe(
        "requires mentionedAt offset from LLM extraction",
        "test_fact_ordering.py::test_first_fact_close_to_event_date",
      )
    })
  })

  describe("mentionedAt offsets", () => {
    it("each fact gets a unique mentionedAt offset", () => {
      implementMe(
        "requires mentionedAt offset from LLM extraction",
        "test_fact_ordering.py::test_unique_mentioned_at",
      )
    })

    it("offset increments by at least 1ms per fact", () => {
      implementMe(
        "requires mentionedAt offset from LLM extraction",
        "test_fact_ordering.py::test_offset_increment",
      )
    })

    it("ordering survives recall retrieval", () => {
      implementMe(
        "requires mentionedAt offset from LLM extraction",
        "test_fact_ordering.py::test_ordering_survives_recall",
      )
    })
  })

  describe("multiple documents ordering", () => {
    it("facts from different documents have distinct mentionedAt timestamps", () => {
      implementMe(
        "requires mentionedAt offset from LLM extraction",
        "test_fact_ordering.py::test_distinct_timestamps_across_documents",
      )
    })

    it("batch retain of multiple documents produces at least 2 unique timestamps across results", () => {
      implementMe(
        "requires mentionedAt offset from LLM extraction",
        "test_fact_ordering.py::test_batch_retain_unique_timestamps",
      )
    })
  })
})
