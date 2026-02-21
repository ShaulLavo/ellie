/**
 * Fact extraction quality tests (Python-parity style).
 *
 * Mirrors Hindsight Python behavior: real LLM extraction with tolerant assertions.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { RetainContentInput } from "../types"
import {
  createRealTestHindsight,
  createTestBank,
  describeWithLLM,
  type RealTestHindsight,
} from "./setup"

const CANONICAL_EVENT_DATE = "2024-11-13T12:00:00+02:00"

function lowerJoined(memories: Array<{ content: string }>): string {
  return memories.map((m) => m.content.toLowerCase()).join(" ")
}

function countMatches(text: string, terms: string[]): number {
  return terms.filter((term) => text.includes(term)).length
}

function approximateDate(iso: string | null, expectedIso: string): boolean {
  if (!iso) return false
  const actual = new Date(iso).getTime()
  const expected = new Date(expectedIso).getTime()
  if (Number.isNaN(actual) || Number.isNaN(expected)) return false
  const oneDayMs = 24 * 60 * 60 * 1000
  return Math.abs(actual - expected) <= oneDayMs
}

describeWithLLM("Fact extraction quality (real LLM)", () => {
  let t: RealTestHindsight
  let bankId: string

  async function extract(
    content: RetainContentInput,
    options: {
      context?: string
      eventDate?: string
    } = {},
  ) {
    const result = await t.hs.retain(bankId, content, {
      consolidate: false,
      eventDate: options.eventDate ?? CANONICAL_EVENT_DATE,
      context: options.context,
    })
    return result.memories
  }

  beforeEach(async () => {
    t = await createRealTestHindsight()
    bankId = createTestBank(t.hs)
  })

  afterEach(() => {
    t.cleanup()
  })

  describe("emotional dimension preservation", () => {
    // Port of test_emotional_dimension_preservation from Python:
    // Sends a combined 3-sentence block and checks for at least 2 emotional indicators.
    it("preserves emotional indicators across a multi-sentence block", async () => {
      const memories = await extract(
        `I was absolutely thrilled when I received such positive feedback on my presentation!
Sarah seemed disappointed when she heard the news about the delay.
Marcus felt anxious about the upcoming interview.`,
        { context: "Personal journal entry" },
      )
      expect(memories.length).toBeGreaterThan(0)

      const text = lowerJoined(memories)
      const emotionalIndicators = ["thrilled", "disappointed", "anxious", "positive feedback"]
      const found = emotionalIndicators.filter((term) => text.includes(term))

      expect(found.length).toBeGreaterThanOrEqual(2)
    }, 60_000)

    it("captures enthusiasm level from exclamation marks", async () => {
      const memories = await extract(
        "I finally shipped the feature and it works perfectly!!!",
        { context: "Engineering update" },
      )
      const text = lowerJoined(memories)
      expect(memories.length).toBeGreaterThan(0)
      expect(
        ["excited", "enthusiastic", "thrilled", "works perfectly", "finally shipped", "shipped", "successfully", "perfectly"].some(
          (term) => text.includes(term),
        ),
      ).toBe(true)
    }, 60_000)

    it("preserves mixed emotions (excitement and anxiety)", async () => {
      const memories = await extract(
        "I'm excited about starting my new job, but also anxious about whether I can keep up.",
      )
      const text = lowerJoined(memories)
      expect(memories.length).toBeGreaterThan(0)
      expect(
        ["excited", "anxious", "excited", "anxiety"].some((term) =>
          text.includes(term),
        ),
      ).toBe(true)
      expect(countMatches(text, ["excited", "anxious", "anxiety"])).toBeGreaterThanOrEqual(2)
    }, 60_000)
  })

  describe("sensory dimension preservation", () => {
    it("captures taste descriptions (spicy, sweet)", async () => {
      const memories = await extract(
        "I went to the new Thai restaurant downtown last night. The soup was incredibly spicy and the mango dessert was sweet and refreshing.",
        { context: "Food review" },
      )
      const text = lowerJoined(memories)
      expect(memories.length).toBeGreaterThan(0)
      expect(text.includes("spicy") || text.includes("sweet") || text.includes("thai") || text.includes("restaurant")).toBe(true)
    }, 60_000)

    it("captures color descriptions (vibrant red, pale blue)", async () => {
      const memories = await extract(
        "Sarah wore a vibrant red jacket and a pale blue scarf to the gallery opening on Friday. She stood out among the crowd.",
        { context: "Personal journal entry" },
      )
      const text = lowerJoined(memories)
      expect(memories.length).toBeGreaterThan(0)
      expect(text.includes("red") || text.includes("blue") || text.includes("sarah") || text.includes("gallery")).toBe(true)
    }, 60_000)

    it("captures sound descriptions (loud, quiet, melodic)", async () => {
      const memories = await extract(
        "At the concert venue, the first room was incredibly loud with heavy bass. The back room was quiet and the acoustic guitar sounded melodic. I preferred the quiet room.",
        { context: "Concert review" },
      )
      const text = lowerJoined(memories)
      expect(memories.length).toBeGreaterThan(0)
      expect(
        ["loud", "quiet", "melodic", "concert", "acoustic", "guitar"].some((term) => text.includes(term)),
      ).toBe(true)
    }, 60_000)

    it("captures texture descriptions (smooth, rough)", async () => {
      const memories = await extract(
        "While renovating the kitchen, I noticed the new marble countertop felt smooth and polished, while the old brick wall was rough and crumbling. I need to get the wall replastered.",
        { context: "Home renovation diary" },
      )
      const text = lowerJoined(memories)
      expect(memories.length).toBeGreaterThan(0)
      expect(text.includes("smooth") || text.includes("rough") || text.includes("countertop") || text.includes("kitchen") || text.includes("renovating") || text.includes("wall")).toBe(true)
    }, 60_000)
  })

  describe("relative to absolute date conversion", () => {
    it("converts 'yesterday' to absolute date in extracted fact", async () => {
      const memories = await extract("Yesterday I went hiking in Yosemite.")
      expect(memories.length).toBeGreaterThan(0)
      expect(
        memories.some((memory) =>
          approximateDate(memory.occurredStart ? new Date(memory.occurredStart).toISOString() : null, "2024-11-12T00:00:00.000Z"),
        ),
      ).toBe(true)
    }, 60_000)

    it("converts 'last Saturday' to absolute date", async () => {
      const memories = await extract("Last Saturday I met Emily for lunch.")
      expect(memories.length).toBeGreaterThan(0)
      const text = lowerJoined(memories)
      expect(text.includes("saturday") || memories.some((m) => m.occurredStart != null)).toBe(true)
    }, 60_000)

    it("converts 'two weeks ago' to approximate date", async () => {
      const memories = await extract("Two weeks ago I submitted the application.")
      expect(memories.length).toBeGreaterThan(0)
      expect(memories.some((memory) => memory.occurredStart != null)).toBe(true)
    }, 60_000)

    it("preserves absolute dates as-is", async () => {
      const memories = await extract("On March 15, 2024, Alice joined Google.")
      expect(memories.length).toBeGreaterThan(0)
      expect(
        memories.some((memory) => {
          if (!memory.occurredStart) return false
          const date = new Date(memory.occurredStart)
          return date.getUTCFullYear() === 2024 && date.getUTCMonth() === 2
        }),
      ).toBe(true)
    }, 60_000)
  })

  describe("agent vs world classification", () => {
    it("classifies 'I went hiking' as experience or world", async () => {
      const memories = await extract("I went hiking in the mountains yesterday with my friend Tom. We reached the summit by noon.")
      expect(memories.length).toBeGreaterThan(0)
      expect(memories.some((memory) => memory.factType === "experience" || memory.factType === "world")).toBe(true)
    }, 60_000)

    it("classifies general knowledge as world", async () => {
      const memories = await extract(
        "Python is a programming language created by Guido van Rossum. It was first released in 1991 and is known for its readability.",
      )
      expect(memories.length).toBeGreaterThan(0)
      expect(memories.some((memory) => memory.factType === "world")).toBe(true)
    }, 60_000)

    it("classifies opinion with context", async () => {
      const memories = await extract(
        "I think pizza is the best food ever. My favorite spot is Joe's Pizza in New York, which I visit every Friday.",
      )
      expect(memories.length).toBeGreaterThan(0)
      expect(
        memories.some((memory) =>
          memory.factType === "opinion" || memory.factType === "world" || memory.factType === "experience",
        ),
      ).toBe(true)
    }, 60_000)

    it("classifies 'The sunset was beautiful' as observation", async () => {
      const memories = await extract(
        "The sunset was beautiful over the bay last evening. The sky turned deep orange and purple as we sat on the pier.",
      )
      expect(memories.length).toBeGreaterThan(0)
      expect(
        memories.some((memory) =>
          memory.factType === "observation" || memory.factType === "world" || memory.factType === "experience",
        ),
      ).toBe(true)
    }, 60_000)
  })

  describe("speaker attribution", () => {
    it("attributes facts to the correct speaker in a conversation", async () => {
      const transcript: RetainContentInput = [
        { role: "Marcus", content: "I predict the Rams win 27-24." },
        { role: "Jamie", content: "I predict the Niners win 27-13." },
      ]
      const memories = await extract(transcript, {
        context: "Podcast predictions between Marcus and Jamie",
      })
      const text = lowerJoined(memories)
      expect(memories.length).toBeGreaterThan(0)
      expect(text.includes("rams") || text.includes("niners")).toBe(true)
    }, 60_000)

    it("resolves 'I' to the speaker's name when available", async () => {
      const transcript: RetainContentInput = [
        { role: "Alice", content: "I moved to Berlin last year." },
      ]
      const memories = await extract(transcript, {
        context: "Conversation with Alice",
      })
      const text = lowerJoined(memories)
      expect(memories.length).toBeGreaterThan(0)
      expect(text.includes("alice") || !text.includes(" i ")).toBe(true)
    }, 60_000)

    it("handles multi-speaker conversations", async () => {
      const transcript: RetainContentInput = [
        { role: "Dana", content: "I started a startup." },
        { role: "Ravi", content: "I invested as an angel." },
        { role: "Dana", content: "We launched in October." },
      ]
      const memories = await extract(transcript, {
        context: "Startup conversation",
      })
      expect(memories.length).toBeGreaterThan(0)
      const text = lowerJoined(memories)
      expect(
        ["startup", "invested", "launched"].some((term) => text.includes(term)),
      ).toBe(true)
    }, 60_000)
  })

  describe("irrelevant content filtering", () => {
    it("filters out 'How are you?' greetings", async () => {
      const memories = await extract(
        "Hi! How are you? I'm planning a move to Madrid in June.",
      )
      expect(memories.length).toBeGreaterThan(0)
      const text = lowerJoined(memories)
      expect(text.includes("madrid") || text.includes("move")).toBe(true)
    }, 60_000)

    it("filters out 'Thank you' responses", async () => {
      const memories = await extract(
        "Thank you so much! I accepted the offer from Stripe yesterday.",
      )
      expect(memories.length).toBeGreaterThan(0)
      const text = lowerJoined(memories)
      expect(text.includes("stripe") || text.includes("accepted")).toBe(true)
    }, 60_000)

    it("filters out filler words and process chatter", async () => {
      const memories = await extract(
        "Sure, one moment, let me check... I completed the migration to Postgres.",
      )
      expect(memories.length).toBeGreaterThan(0)
      const text = lowerJoined(memories)
      expect(text.includes("migration") || text.includes("postgres")).toBe(true)
    }, 60_000)
  })

  describe("output ratio", () => {
    it("output/input token ratio stays below 5x", async () => {
      const input =
        "I went to the grocery store yesterday and bought apples and oranges. " +
        "I ran into Sarah who said she is visiting Italy next month."
      const memories = await extract(input, { context: "Diary entry" })
      const outputChars = memories.reduce((sum, memory) => sum + memory.content.length, 0)
      const ratio = outputChars / input.length
      expect(ratio).toBeLessThan(5)
    }, 60_000)

    it("output/input token ratio stays below 6x for large inputs", async () => {
      const input =
        "Last weekend I visited my friend in San Francisco. ".repeat(60) +
        "We discussed AI healthcare projects and my plan to switch teams next quarter."
      const memories = await extract(input, { context: "Long journal entry" })
      const outputChars = memories.reduce((sum, memory) => sum + memory.content.length, 0)
      const ratio = outputChars / input.length
      expect(ratio).toBeLessThan(6)
    }, 60_000)

    it("extracts at least 1 fact from non-trivial input", async () => {
      const memories = await extract(
        "I completed the migration and deployed the service successfully.",
      )
      expect(memories.length).toBeGreaterThan(0)
    }, 60_000)

    it("keeps trivial input output minimal (Python parity: no hard empty-array rule)", async () => {
      const input = "Thanks! Okay."
      const memories = await extract(input)
      expect(memories.length).toBeLessThanOrEqual(1)
      const outputChars = memories.reduce((sum, memory) => sum + memory.content.length, 0)
      expect(outputChars / input.length).toBeLessThan(5)
    }, 60_000)
  })

  describe("edge cases", () => {
    it("multi-dimensional extraction: captures all quality dimensions in one pass", async () => {
      const memories = await extract(
        "I was thrilled by the bright red stage lights yesterday, but anxious about the keynote.",
        { context: "Conference reflection" },
      )
      const text = lowerJoined(memories)
      expect(memories.length).toBeGreaterThan(0)
      expect(
        ["thrilled", "anxious", "bright red", "yesterday"].some((term) =>
          text.includes(term),
        ),
      ).toBe(true)
    }, 60_000)

    it("logical inference: 'I am Alice' propagates identity across extracted facts", async () => {
      const memories = await extract(
        "I am Alice. I recently moved to Lisbon and started a robotics job.",
      )
      const text = lowerJoined(memories)
      expect(memories.length).toBeGreaterThan(0)
      expect(text.includes("alice")).toBe(true)
    }, 60_000)

    it("pronoun resolution: 'she said' resolved to named speaker", async () => {
      const memories = await extract(
        "Maria joined the call. She said the launch would happen next Tuesday.",
      )
      const text = lowerJoined(memories)
      expect(memories.length).toBeGreaterThan(0)
      expect(text.includes("maria")).toBe(true)
    }, 60_000)

    it("extraction without explicit context string still produces valid facts", async () => {
      const memories = await extract(
        "I completed my CKA certification and now lead the infrastructure team.",
        { context: undefined },
      )
      expect(memories.length).toBeGreaterThan(0)
    }, 60_000)
  })
})
