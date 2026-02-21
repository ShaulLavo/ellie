/**
 * Deterministic eval runner for Hindsight recall quality.
 *
 * Pipeline: load fixture → seed memories → execute recall → collect candidates → score.
 *
 * Reproducibility knobs:
 * - Fixed seed for deterministic ID generation
 * - Fixed topK (default 10)
 * - Stable sort tie-breakers by (score DESC, id ASC)
 * - UTC timestamps in outputs
 */

import { tmpdir } from "os"
import { join } from "path"
import { readFileSync, rmSync } from "fs"
import { Hindsight } from "@ellie/hindsight"
import type { HindsightConfig, RecallOptions } from "@ellie/hindsight"
import { scoreCase } from "./scoring"
import type {
  EvalCase,
  EvalRunConfig,
  EvalCaseResult,
  RecallCandidate,
} from "./types"

// ── Deterministic embedding ───────────────────────────────────────────────

const EVAL_EMBED_DIMS = 16

/**
 * Hash-based embedding for deterministic eval runs.
 * NOT semantically meaningful — produces consistent vectors for identical text.
 */
function deterministicEmbed(text: string): Promise<number[]> {
  const vec = Array.from<number>({ length: EVAL_EMBED_DIMS }).fill(0)
  for (let i = 0; i < text.length; i++) {
    vec[i % EVAL_EMBED_DIMS]! += text.charCodeAt(i) / 1000
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  return Promise.resolve(norm > 0 ? vec.map((v) => v / norm) : vec)
}

// ── Mock adapter ──────────────────────────────────────────────────────────

/**
 * Minimal mock adapter for eval — retain uses pre-extracted facts so
 * the LLM is never called. Required by the Hindsight constructor.
 */
function createEvalAdapter(): HindsightConfig["adapter"] {
  return {
    kind: "text" as const,
    name: "eval-noop",
    model: "eval-noop",
    chatStream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "TEXT_MESSAGE_START" as const, messageId: "eval", timestamp: Date.now(), model: "eval-noop" }
          yield { type: "TEXT_MESSAGE_CONTENT" as const, messageId: "eval", delta: "{}", timestamp: Date.now(), model: "eval-noop" }
          yield { type: "TEXT_MESSAGE_END" as const, messageId: "eval", timestamp: Date.now(), model: "eval-noop" }
          yield { type: "RUN_FINISHED" as const, runId: "eval", timestamp: Date.now(), model: "eval-noop" }
        },
      }
    },
    structuredOutput() {
      return Promise.resolve({ data: {}, rawResponse: "{}" })
    },
  } as unknown as NonNullable<HindsightConfig["adapter"]>
}

// ── Deterministic ID generator ────────────────────────────────────────────

/**
 * Creates a seeded ULID-like ID generator for reproducible memory IDs.
 * Format: "eval-{caseIndex}-{factIndex}" padded for lexicographic sort.
 */
function makeIdGenerator(caseIndex: number) {
  let factCounter = 0
  return () => {
    const id = `eval_${String(caseIndex).padStart(4, "0")}_${String(factCounter).padStart(4, "0")}`
    factCounter++
    return id
  }
}

// ── Fixture loading ───────────────────────────────────────────────────────

export function loadFixture(path: string): EvalCase[] {
  const raw = readFileSync(path, "utf-8")
  const lines = raw.trim().split("\n").filter((line) => line.trim().length > 0)
  return lines.map((line) => JSON.parse(line) as EvalCase)
}

// ── Core runner ───────────────────────────────────────────────────────────

export interface RunBaselineOptions {
  config: EvalRunConfig
  /** Override embedding function (for tests with real embeddings) */
  embed?: (text: string) => Promise<number[]>
  /** Override embedding dimensions */
  embeddingDimensions?: number
}

/**
 * Run the full eval pipeline:
 * 1. Load fixture
 * 2. For each case: create fresh DB, seed memories, run recall, score
 * 3. Return all case results
 */
export async function runBaseline(
  options: RunBaselineOptions,
): Promise<EvalCaseResult[]> {
  const { config, embed, embeddingDimensions } = options
  const cases = loadFixture(config.datasetPath)
  const results: EvalCaseResult[] = []

  for (let caseIdx = 0; caseIdx < cases.length; caseIdx++) {
    const evalCase = cases[caseIdx]!
    const result = await runSingleCase(
      evalCase,
      caseIdx,
      config,
      embed ?? deterministicEmbed,
      embeddingDimensions ?? EVAL_EMBED_DIMS,
    )
    results.push(result)
  }

  return results
}

async function runSingleCase(
  evalCase: EvalCase,
  caseIndex: number,
  config: EvalRunConfig,
  embed: (text: string) => Promise<number[]>,
  embeddingDimensions: number,
): Promise<EvalCaseResult> {
  const dbPath = join(
    tmpdir(),
    `hindsight-eval-${Date.now()}-${caseIndex}.db`,
  )

  const hs = new Hindsight({
    dbPath,
    embed,
    embeddingDimensions,
    adapter: createEvalAdapter(),
  })

  try {
    const startTime = Date.now()

    // Create bank
    const bank = hs.createBank(`eval-bank-${caseIndex}`)
    const bankId = bank.id
    const nextId = makeIdGenerator(caseIndex)

    // Seed memories using pre-extracted facts (bypasses LLM)
    const baseTimestamp = new Date("2025-01-01T00:00:00Z").getTime()
    const facts = evalCase.seedFacts.map((fact, i) => ({
      content: fact.content,
      factType: fact.factType,
      confidence: fact.confidence ?? 1.0,
      occurredStart: fact.occurredStart ?? (baseTimestamp + i * 60_000),
      occurredEnd: fact.occurredEnd ?? null,
      entities: fact.entities ?? [],
      tags: fact.tags ?? [],
    }))

    await hs.retain(bankId, "eval seed content", {
      facts,
      consolidate: false,
      dedupThreshold: 0,
    })

    // Execute recall
    const topK = evalCase.constraints?.topK ?? config.topK
    const recallOptions: RecallOptions = {
      limit: topK,
      maxTokens: evalCase.constraints?.tokenBudget,
      enableTrace: true,
    }

    const recallResult = await hs.recall(bankId, evalCase.query, recallOptions)

    // Collect candidates with stable tie-breaking: (score DESC, id ASC)
    const candidates: RecallCandidate[] = recallResult.memories
      .map((scored, idx) => ({
        memoryId: scored.memory.id,
        content: scored.memory.content,
        score: scored.score,
        rank: idx + 1,
        sources: [...scored.sources],
        factType: scored.memory.factType,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return a.memoryId.localeCompare(b.memoryId)
      })
      .map((c, idx) => ({ ...c, rank: idx + 1 }))

    const durationMs = Date.now() - startTime

    // Score
    const metrics = scoreCase(evalCase, candidates)

    return {
      caseId: evalCase.id,
      scenario: evalCase.scenario,
      query: evalCase.query,
      candidates,
      durationMs,
      metrics,
    }
  } finally {
    hs.close()
    try {
      rmSync(dbPath, { force: true })
      rmSync(dbPath + "-wal", { force: true })
      rmSync(dbPath + "-shm", { force: true })
    } catch {
      // cleanup best-effort
    }
  }
}
