/**
 * Phase 2 Verification Types
 *
 * Defines types for the Phase 2 verification harness:
 * - Rolling ingest dataset items
 * - Temporal narrative QA items
 * - Metric computation results
 * - Gate pass/fail results
 * - Verification report structure
 */

// ── Rolling Ingest Dataset ──────────────────────────────────────────────

export interface RollingIngestEvent {
  /** Unique event identifier */
  eventId: string
  /** Cluster identifier for grouping related events */
  clusterId: string
  /** Content of the memory */
  content: string
  /** Entity name */
  entity: string
  /** Attribute key for conflict detection */
  attribute: string
  /** Attribute value */
  value: string
  /** Scope for episode boundary detection */
  scope: string
  /** Timestamp (epoch ms) */
  timestamp: number
  /** Fact type */
  factType: "world" | "experience" | "opinion" | "observation"
  /** Tags for filtering */
  tags?: string[]
}

// ── Temporal Narrative QA Dataset ────────────────────────────────────────

export interface TemporalNarrativeQuestion {
  /** Unique question identifier */
  questionId: string
  /** Question text */
  question: string
  /** Anchor memory ID for narrative query */
  anchorMemoryId: string
  /** Expected ordered memory IDs in narrative output */
  expectedOrderedMemoryIds: string[]
  /** Direction for narrative query */
  direction: "before" | "after" | "both"
}

// ── Metric Results ──────────────────────────────────────────────────────

export interface DuplicateRatioMetrics {
  /** Total canonical count across all clusters */
  totalCanonicalCount: number
  /** Total duplicates (sum of max(0, count-1) per cluster) */
  totalDuplicates: number
  /** DR = duplicates / totalCanonicalCount */
  duplicateRatio: number
}

export interface NarrativeAccuracyMetrics {
  /** Total questions evaluated */
  totalQuestions: number
  /** Questions where required memory IDs appear in correct order */
  correctQuestions: number
  /** accuracy = correct / total */
  accuracy: number
}

// ── Gate Results ─────────────────────────────────────────────────────────

export type GateStatus = "pass" | "fail" | "skip"

export interface GateResult {
  gate: string
  status: GateStatus
  description: string
  details: Record<string, unknown>
}

// ── Verification Run Output ─────────────────────────────────────────────

export interface Phase2VerificationRun {
  /** ISO timestamp of the run */
  timestamp: string
  /** Git SHA at time of run */
  gitSha: string
  /** Run identifier (a or b for reproducibility) */
  runId: string
  /** Gate results */
  gates: GateResult[]
  /** Overall pass/fail */
  passed: boolean
  /** Metrics snapshot */
  metrics: {
    duplicateRatio?: DuplicateRatioMetrics
    narrativeAccuracy?: NarrativeAccuracyMetrics
  }
}

// ── Comparison Report ───────────────────────────────────────────────────

export interface Phase2ComparisonReport {
  /** Baseline run results */
  baseline: {
    duplicateRatio: number
    narrativeAccuracy: number
  }
  /** Candidate (Phase 2) run results */
  candidate: {
    duplicateRatio: number
    narrativeAccuracy: number
  }
  /** Improvement calculations */
  improvements: {
    duplicateRatioReduction: number
    duplicateRatioReductionPercent: number
    narrativeAccuracyImprovement: number
    narrativeAccuracyImprovementPercent: number
  }
  /** Gate 6/7 pass/fail */
  gate6Pass: boolean
  gate7Pass: boolean
}
