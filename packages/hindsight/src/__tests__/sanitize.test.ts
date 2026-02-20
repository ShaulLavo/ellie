/**
 * Tests for sanitize.ts — text sanitization and JSON parsing utilities.
 *
 * Pure unit tests — no DB or LLM needed.
 */

import { describe, it, expect } from "bun:test"
import { sanitizeText, parseLLMJson } from "../sanitize"

// ════════════════════════════════════════════════════════════════════════════
// sanitizeText
// ════════════════════════════════════════════════════════════════════════════

describe("sanitizeText", () => {
  it("removes null bytes", () => {
    expect(sanitizeText("hello\x00world")).toBe("helloworld")
  })

  it("removes multiple null bytes", () => {
    expect(sanitizeText("\x00a\x00b\x00c\x00")).toBe("abc")
  })

  it("removes lone surrogates", () => {
    expect(sanitizeText("hello\uD800world")).toBe("helloworld")
    expect(sanitizeText("hello\uDFFFworld")).toBe("helloworld")
  })

  it("preserves valid ASCII and CJK text", () => {
    // Note: sanitizeText strips all surrogate code units (including valid pairs),
    // so emoji get removed. CJK and accented characters are fine (they're in BMP).
    expect(sanitizeText("Hello, World! 日本語 Ñ")).toBe("Hello, World! 日本語 Ñ")
  })

  it("handles empty string", () => {
    expect(sanitizeText("")).toBe("")
  })

  it("handles string with only null bytes", () => {
    expect(sanitizeText("\x00\x00\x00")).toBe("")
  })

  it("preserves valid emoji (surrogate pairs are preserved)", () => {
    // Implementation was fixed to only strip lone/unpaired surrogates,
    // preserving valid emoji formed from proper surrogate pairs.
    expect(sanitizeText("Party 🎉 time!")).toBe("Party 🎉 time!")
  })

  it("removes mixed null bytes and surrogates", () => {
    expect(sanitizeText("a\x00b\uD800c")).toBe("abc")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// parseLLMJson
// ════════════════════════════════════════════════════════════════════════════

describe("parseLLMJson", () => {
  it("parses plain JSON", () => {
    const result = parseLLMJson('{"name": "test"}', {})
    expect(result).toEqual({ name: "test" })
  })

  it("strips json code fences", () => {
    const input = '```json\n{"name": "test"}\n```'
    expect(parseLLMJson(input, {})).toEqual({ name: "test" })
  })

  it("strips bare code fences", () => {
    const input = '```\n{"name": "test"}\n```'
    expect(parseLLMJson(input, {})).toEqual({ name: "test" })
  })

  it("returns fallback on invalid JSON", () => {
    expect(parseLLMJson("not json at all", { default: true })).toEqual({
      default: true,
    })
  })

  it("returns fallback on empty string", () => {
    expect(parseLLMJson("", [])).toEqual([])
  })

  it("handles whitespace around JSON", () => {
    const input = "  \n  {\"key\": \"value\"}  \n  "
    expect(parseLLMJson(input, {})).toEqual({ key: "value" })
  })

  it("parses arrays", () => {
    const input = '[{"action": "create", "text": "observation"}]'
    expect(parseLLMJson(input, [])).toEqual([
      { action: "create", text: "observation" },
    ])
  })

  it("handles nested JSON in code fences", () => {
    const input = `\`\`\`json
{
  "facts": [
    {
      "content": "Test fact",
      "factType": "world"
    }
  ]
}
\`\`\``
    const result = parseLLMJson(input, { facts: [] })
    expect(result.facts).toHaveLength(1)
    expect(result.facts[0].content).toBe("Test fact")
  })

  it("returns fallback for partial JSON", () => {
    expect(parseLLMJson('{"incomplete": ', null)).toBeNull()
  })
})
