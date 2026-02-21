/**
 * Types for the Hindsight offline eval harness.
 *
 * Defines the eval case schema, run config, scoring results,
 * and report structures used throughout the harness.
 */

// ── Scenario Families ─────────────────────────────────────────────────────

export type Scenario =
  | "follow_up_recall"
  | "temporal_narrative"
  | "dedup_conflict"
  | "code_location_recall"
  | "token_budget_packing"

// ── Eval Case ─────────────────────────────────────────────────────────────

export interface SeedFact {
  content: string
  factType: "world" | "experience" | "opinion" | "observation"
  confidence?: number
  occurredStart?: number | null
  occurredEnd?: number | null
  entities?: string[]
  tags?: string[]
}

export interface EvalCase {
  id: string
  scenario: Scenario
  description: string
  seedFacts: SeedFact[]
  query: string
  expected: {
    /** Memory content substrings that MUST appear in top-k results */
    mustInclude?: string[]
    /** Memory content substrings that must NOT appear in top-k results */
    mustExclude?: string[]
    /** Expected ordering hints — earlier items should rank higher */
    orderedHints?: string[]
    /** Specific memory IDs expected in results (for deterministic seeding) */
    expectedIds?: string[]
  }
  constraints?: {
    tokenBudget?: number
    topK?: number
  }
}

// ── Run Config ────────────────────────────────────────────────────────────

export interface EvalRunConfig {
  datasetPath: string
  mode: "hybrid"
  seed: number
  topK: number
  outputDir: string
}

// ── Scored Result (per case) ──────────────────────────────────────────────

export interface RecallCandidate {
  memoryId: string
  content: string
  score: number
  rank: number
  sources: string[]
  factType: string
}

export interface EvalCaseResult {
  caseId: string
  scenario: Scenario
  query: string
  candidates: RecallCandidate[]
  durationMs: number
  /** Scenario-specific metric scores */
  metrics: Record<string, number>
}

// ── Scenario Metrics ──────────────────────────────────────────────────────

export interface FollowUpRecallMetrics {
  "recall@1": number
  "recall@3": number
  "recall@5": number
  mrr: number
}

export interface TemporalNarrativeMetrics {
  orderingAccuracy: number
  predecessorHitRate: number
  successorHitRate: number
}

export interface DedupConflictMetrics {
  duplicateHitRatio: number
  contradictionRetrievalRate: number
}

export interface CodeLocationRecallMetrics {
  "pathRecall@k": number
  exactPathPrecision: number
}

export interface TokenBudgetPackingMetrics {
  factRetentionRate: number
  truncationLossRate: number
}

// ── Aggregate Report ──────────────────────────────────────────────────────

export interface ScenarioSummary {
  scenario: Scenario
  caseCount: number
  metrics: Record<string, number>
}

export interface EvalReport {
  version: string
  datasetVersion: string
  runConfig: EvalRunConfig
  runMetadata: {
    gitSha: string
    bunVersion: string
    timestamp: string
    seed: number
    topK: number
  }
  scenarios: ScenarioSummary[]
  globalScore: number
  globalWeights: Record<Scenario, number>
  cases: EvalCaseResult[]
  totalDurationMs: number
}
