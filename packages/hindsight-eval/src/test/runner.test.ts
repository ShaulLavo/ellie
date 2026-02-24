import { describe, it, expect } from "bun:test"
import { join } from "path"
import { loadFixture, runBaseline } from "../runner"
import type { EvalRunConfig } from "../types"

const FIXTURE_PATH = join(import.meta.dir, "../../fixtures/assistant-baseline.v1.jsonl")

describe("runner", () => {
  describe("loadFixture", () => {
    it("loads all cases from the JSONL fixture", () => {
      const cases = loadFixture(FIXTURE_PATH)
      expect(cases.length).toBe(25)
    })

    it("parses each case with required fields", () => {
      const cases = loadFixture(FIXTURE_PATH)
      for (const c of cases) {
        expect(c.id).toBeDefined()
        expect(c.scenario).toBeDefined()
        expect(c.seedFacts.length).toBeGreaterThan(0)
        expect(c.query).toBeDefined()
        expect(c.expected).toBeDefined()
      }
    })

    it("includes all 5 scenario families", () => {
      const cases = loadFixture(FIXTURE_PATH)
      const scenarios = new Set(cases.map((c) => c.scenario))
      expect(scenarios.has("follow_up_recall")).toBe(true)
      expect(scenarios.has("temporal_narrative")).toBe(true)
      expect(scenarios.has("dedup_conflict")).toBe(true)
      expect(scenarios.has("code_location_recall")).toBe(true)
      expect(scenarios.has("token_budget_packing")).toBe(true)
    })
  })

  describe("runBaseline", () => {
    it("produces deterministic results across runs", async () => {
      const config: EvalRunConfig = {
        datasetPath: FIXTURE_PATH,
        mode: "hybrid",
        seed: 42,
        topK: 10,
        outputDir: "",
      }

      const results1 = await runBaseline({ config })
      const results2 = await runBaseline({ config })

      expect(results1.length).toBe(results2.length)

      for (let i = 0; i < results1.length; i++) {
        const r1 = results1[i]!
        const r2 = results2[i]!

        expect(r1.caseId).toBe(r2.caseId)
        expect(r1.candidates.length).toBe(r2.candidates.length)

        for (let j = 0; j < r1.candidates.length; j++) {
          expect(r1.candidates[j]!.content).toBe(r2.candidates[j]!.content)
          expect(r1.candidates[j]!.score).toBe(r2.candidates[j]!.score)
        }

        expect(Object.keys(r1.metrics).length).toBe(Object.keys(r2.metrics).length)
        for (const key of Object.keys(r1.metrics)) {
          expect(r1.metrics[key]).toBe(r2.metrics[key])
        }
      }
    }, 30_000)

    it("returns metrics for each case", async () => {
      const config: EvalRunConfig = {
        datasetPath: FIXTURE_PATH,
        mode: "hybrid",
        seed: 42,
        topK: 10,
        outputDir: "",
      }

      const results = await runBaseline({ config })

      for (const result of results) {
        expect(Object.keys(result.metrics).length).toBeGreaterThan(0)
        for (const value of Object.values(result.metrics)) {
          expect(typeof value).toBe("number")
          expect(value).toBeGreaterThanOrEqual(0)
          expect(value).toBeLessThanOrEqual(1)
        }
      }
    }, 15_000)

    it("respects stable tie-breaking (score DESC, content ASC)", async () => {
      const config: EvalRunConfig = {
        datasetPath: FIXTURE_PATH,
        mode: "hybrid",
        seed: 42,
        topK: 10,
        outputDir: "",
      }

      const results = await runBaseline({ config })

      for (const result of results) {
        for (let i = 1; i < result.candidates.length; i++) {
          const prev = result.candidates[i - 1]!
          const curr = result.candidates[i]!

          if (prev.score === curr.score) {
            // Same score → content should be ascending
            expect(prev.content.localeCompare(curr.content)).toBeLessThanOrEqual(0)
          } else {
            // Scores should be descending
            expect(prev.score).toBeGreaterThanOrEqual(curr.score)
          }
        }
      }
    }, 15_000)
  })
})
