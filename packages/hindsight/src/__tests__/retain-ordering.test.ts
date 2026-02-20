/**
 * Tests for fact ordering — temporal ordering within documents.
 *
 * Port of test_fact_ordering.py.
 * TDD targets — these require real LLM extraction.
 */

import { describe, it } from "bun:test"

describe("Fact ordering", () => {
  describe("temporal ordering within a conversation", () => {
    it.todo("facts from same conversation maintain temporal order via mentionedAt")
    it.todo("later facts have higher mentionedAt than earlier facts")
    it.todo("first fact has mentionedAt close to event_date")
  })

  describe("mentionedAt offsets", () => {
    it.todo("each fact gets a unique mentionedAt offset")
    it.todo("offset increments by at least 1ms per fact")
    it.todo("ordering survives recall retrieval")
  })

  describe("multiple documents ordering", () => {
    it.todo("facts from different documents have distinct mentionedAt timestamps")
    it.todo("batch retain of multiple documents produces at least 2 unique timestamps across results")
  })
})
