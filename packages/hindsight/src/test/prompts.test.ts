/**
 * Tests for prompts.ts — LLM prompt templates and directive injection.
 *
 * Port of directive-related tests from test_reflections.py.
 * Pure unit tests — no DB or LLM needed.
 */

import { describe, it, expect } from "bun:test"
import {
  buildDirectivesSection,
  buildDirectivesReminder,
  getExtractionPrompt,
  getReflectSystemPrompt,
  EXTRACT_FACTS_SYSTEM,
  EXTRACT_FACTS_VERBOSE_SYSTEM,
} from "../prompts"
import type { Directive } from "../types"

function makeDirective(overrides: Partial<Directive>): Directive {
  return {
    id: "d1",
    bankId: "bank-1",
    name: "Test Directive",
    content: "Always be concise.",
    priority: 0,
    isActive: true,
    tags: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// buildDirectivesSection
// ════════════════════════════════════════════════════════════════════════════

describe("buildDirectivesSection", () => {
  it("returns empty string for no directives", () => {
    expect(buildDirectivesSection([])).toBe("")
  })

  it("includes directive name and content", () => {
    const directives = [makeDirective({ name: "Be Brief", content: "Keep answers short." })]
    const section = buildDirectivesSection(directives)
    expect(section).toContain("Be Brief")
    expect(section).toContain("Keep answers short.")
  })

  it("includes MANDATORY header", () => {
    const directives = [makeDirective({})]
    const section = buildDirectivesSection(directives)
    expect(section).toContain("DIRECTIVES (MANDATORY)")
    expect(section).toContain("MUST follow")
  })

  it("includes multiple directives", () => {
    const directives = [
      makeDirective({ name: "Rule 1", content: "First rule." }),
      makeDirective({ name: "Rule 2", content: "Second rule." }),
    ]
    const section = buildDirectivesSection(directives)
    expect(section).toContain("Rule 1")
    expect(section).toContain("First rule.")
    expect(section).toContain("Rule 2")
    expect(section).toContain("Second rule.")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// buildDirectivesReminder
// ════════════════════════════════════════════════════════════════════════════

describe("buildDirectivesReminder", () => {
  it("returns empty string for no directives", () => {
    expect(buildDirectivesReminder([])).toBe("")
  })

  it("includes REMINDER header", () => {
    const directives = [makeDirective({})]
    const reminder = buildDirectivesReminder(directives)
    expect(reminder).toContain("REMINDER")
    expect(reminder).toContain("MANDATORY")
  })

  it("numbers directives", () => {
    const directives = [
      makeDirective({ name: "Rule A", content: "Do A." }),
      makeDirective({ name: "Rule B", content: "Do B." }),
    ]
    const reminder = buildDirectivesReminder(directives)
    expect(reminder).toContain("1.")
    expect(reminder).toContain("2.")
    expect(reminder).toContain("Rule A")
    expect(reminder).toContain("Rule B")
  })

  it("includes rejection warning", () => {
    const directives = [makeDirective({})]
    const reminder = buildDirectivesReminder(directives)
    expect(reminder).toContain("REJECTED")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// getExtractionPrompt
// ════════════════════════════════════════════════════════════════════════════

describe("getExtractionPrompt", () => {
  it("returns concise prompt by default", () => {
    const prompt = getExtractionPrompt("concise")
    expect(prompt).toBe(EXTRACT_FACTS_SYSTEM)
    expect(prompt).toContain("Be SELECTIVE")
  })

  it("returns verbose prompt", () => {
    const prompt = getExtractionPrompt("verbose")
    expect(prompt).toBe(EXTRACT_FACTS_VERBOSE_SYSTEM)
    expect(prompt).toContain("maximum detail")
  })

  it("injects custom guidelines", () => {
    const prompt = getExtractionPrompt("custom", "Focus on technical details.")
    expect(prompt).not.toBe(EXTRACT_FACTS_SYSTEM)
    expect(prompt).toContain("Focus on technical details.")
  })

  it("falls back to concise if custom mode but no guidelines", () => {
    const prompt = getExtractionPrompt("custom")
    expect(prompt).toBe(EXTRACT_FACTS_SYSTEM)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// getReflectSystemPrompt
// ════════════════════════════════════════════════════════════════════════════

describe("getReflectSystemPrompt", () => {
  it("includes 3-tier hierarchy description", () => {
    const prompt = getReflectSystemPrompt("mid")
    expect(prompt).toContain("TIER 1")
    expect(prompt).toContain("TIER 2")
    expect(prompt).toContain("TIER 3")
    expect(prompt).toContain("Mental Models")
    expect(prompt).toContain("Observations")
    expect(prompt).toContain("Raw Facts")
  })

  it("includes budget-specific guidance for low", () => {
    const prompt = getReflectSystemPrompt("low")
    expect(prompt).toContain("LOW budget")
  })

  it("includes budget-specific guidance for mid", () => {
    const prompt = getReflectSystemPrompt("mid")
    expect(prompt).toContain("MEDIUM budget")
  })

  it("includes budget-specific guidance for high", () => {
    const prompt = getReflectSystemPrompt("high")
    expect(prompt).toContain("HIGH budget")
    expect(prompt).toContain("thorough")
  })
})
