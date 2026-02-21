/**
 * Report generation for the Hindsight eval harness.
 *
 * Produces:
 * - Machine-readable JSON report
 * - Human-readable Markdown summary
 */

import type {
  EvalCaseResult,
  EvalReport,
  EvalRunConfig,
  Scenario,
  ScenarioSummary,
} from "./types"

// ── Scenario weights (committed and immutable for v1) ─────────────────────

const GLOBAL_WEIGHTS: Record<Scenario, number> = {
  follow_up_recall: 0.30,
  temporal_narrative: 0.20,
  dedup_conflict: 0.15,
  code_location_recall: 0.20,
  token_budget_packing: 0.15,
}

// ── Primary metric per scenario (used for global score) ───────────────────

const PRIMARY_METRIC: Record<Scenario, string> = {
  follow_up_recall: "mrr",
  temporal_narrative: "orderingAccuracy",
  dedup_conflict: "contradictionRetrievalRate",
  code_location_recall: "pathRecall@k",
  token_budget_packing: "factRetentionRate",
}

// ── Penalty metrics (lower is better) ──────────────────────────────────────

const PENALTY_METRICS = new Set(["duplicateLeakRate", "truncationLossRate"])

// ── Report generation ─────────────────────────────────────────────────────

export interface GenerateReportOptions {
  config: EvalRunConfig
  cases: EvalCaseResult[]
  gitSha: string
  bunVersion: string
  totalDurationMs: number
}

/**
 * Generate a structured eval report from case results.
 */
export function generateReport(options: GenerateReportOptions): EvalReport {
  const { config, cases, gitSha, bunVersion, totalDurationMs } = options

  // Group cases by scenario
  const byScenario = new Map<Scenario, EvalCaseResult[]>()
  for (const c of cases) {
    const list = byScenario.get(c.scenario) ?? []
    list.push(c)
    byScenario.set(c.scenario, list)
  }

  // Compute per-scenario summaries
  const scenarios: ScenarioSummary[] = []
  for (const [scenario, scenarioCases] of byScenario) {
    const avgMetrics = averageMetrics(scenarioCases)
    scenarios.push({
      scenario,
      caseCount: scenarioCases.length,
      metrics: avgMetrics,
    })
  }

  // Sort scenarios in a deterministic order
  const scenarioOrder: Scenario[] = [
    "follow_up_recall",
    "temporal_narrative",
    "dedup_conflict",
    "code_location_recall",
    "token_budget_packing",
  ]
  scenarios.sort(
    (a, b) => scenarioOrder.indexOf(a.scenario) - scenarioOrder.indexOf(b.scenario),
  )

  // Compute global weighted score (weights sum to 1.0, no re-normalization)
  let globalScore = 0
  for (const summary of scenarios) {
    const weight = GLOBAL_WEIGHTS[summary.scenario]
    const primaryMetric = PRIMARY_METRIC[summary.scenario]
    const value = summary.metrics[primaryMetric] ?? 0
    globalScore += weight * value
  }

  // Flag partial-scenario runs
  const allScenarios: Scenario[] = [
    "follow_up_recall",
    "temporal_narrative",
    "dedup_conflict",
    "code_location_recall",
    "token_budget_packing",
  ]
  const presentScenarios = new Set(scenarios.map((s) => s.scenario))
  const missingScenarios = allScenarios.filter((s) => !presentScenarios.has(s))
  const warnings: string[] = []
  if (missingScenarios.length > 0) {
    warnings.push(
      `Partial dataset: missing scenario families: ${missingScenarios.join(", ")}. ` +
      `Global score only reflects ${presentScenarios.size}/5 families.`,
    )
  }

  return {
    version: "1.0.0",
    datasetVersion: "assistant-baseline.v1",
    runConfig: config,
    runMetadata: {
      gitSha,
      bunVersion,
      timestamp: new Date().toISOString(),
      seed: config.seed,
      topK: config.topK,
    },
    scenarios,
    globalScore,
    globalWeights: GLOBAL_WEIGHTS,
    cases,
    totalDurationMs,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/**
 * Average metrics across multiple cases in the same scenario.
 */
function averageMetrics(cases: EvalCaseResult[]): Record<string, number> {
  if (cases.length === 0) return {}

  const allKeys = new Set<string>()
  for (const c of cases) {
    for (const key of Object.keys(c.metrics)) {
      allKeys.add(key)
    }
  }

  const avg: Record<string, number> = {}
  for (const key of allKeys) {
    const values = cases
      .map((c) => c.metrics[key])
      .filter((v): v is number => v != null)
    avg[key] = values.length > 0
      ? values.reduce((sum, v) => sum + v, 0) / values.length
      : 0
  }
  return avg
}

// ── Markdown report ───────────────────────────────────────────────────────

/**
 * Format an EvalReport as a human-readable Markdown summary.
 */
export function formatMarkdownReport(report: EvalReport): string {
  const lines: string[] = []

  lines.push("# Hindsight Eval Baseline Report")
  lines.push("")
  lines.push(`**Dataset:** ${report.datasetVersion}`)
  lines.push(`**Mode:** ${report.runConfig.mode}`)
  lines.push(`**Seed:** ${report.runConfig.seed}`)
  lines.push(`**Top-K:** ${report.runConfig.topK}`)
  lines.push(`**Git SHA:** \`${report.runMetadata.gitSha}\``)
  lines.push(`**Bun:** ${report.runMetadata.bunVersion}`)
  lines.push(`**Timestamp:** ${report.runMetadata.timestamp}`)
  lines.push(`**Total Duration:** ${report.totalDurationMs}ms`)
  lines.push("")

  // Warnings
  if (report.warnings && report.warnings.length > 0) {
    lines.push("> **Warning:**")
    for (const warning of report.warnings) {
      lines.push(`> ${warning}`)
    }
    lines.push("")
  }

  // Global score
  lines.push(`## Global Score: ${(report.globalScore * 100).toFixed(1)}%`)
  lines.push("")

  // Weights table
  lines.push("### Scenario Weights")
  lines.push("")
  lines.push("| Scenario | Weight | Primary Metric |")
  lines.push("|----------|--------|----------------|")
  for (const scenario of Object.keys(GLOBAL_WEIGHTS) as Scenario[]) {
    const weight = GLOBAL_WEIGHTS[scenario]
    const primary = PRIMARY_METRIC[scenario]
    lines.push(`| ${scenario} | ${(weight * 100).toFixed(0)}% | ${primary} |`)
  }
  lines.push("")

  // Per-scenario tables
  lines.push("## Scenario Results")
  lines.push("")

  for (const summary of report.scenarios) {
    lines.push(`### ${summary.scenario} (${summary.caseCount} cases)`)
    lines.push("")
    lines.push("| Metric | Value |")
    lines.push("|--------|-------|")
    for (const [key, value] of Object.entries(summary.metrics)) {
      const annotation = PENALTY_METRICS.has(key) ? " (lower is better)" : ""
      lines.push(`| ${key}${annotation} | ${(value * 100).toFixed(1)}% |`)
    }
    lines.push("")
  }

  // Per-case details
  lines.push("## Case Details")
  lines.push("")

  for (const c of report.cases) {
    lines.push(`### ${c.caseId} (${c.scenario})`)
    lines.push("")
    lines.push(`**Query:** ${c.query}`)
    lines.push(`**Duration:** ${c.durationMs}ms`)
    lines.push(`**Candidates:** ${c.candidates.length}`)
    lines.push("")

    if (c.candidates.length > 0) {
      lines.push("| Rank | Score | Content (truncated) | Sources |")
      lines.push("|------|-------|---------------------|---------|")
      for (const candidate of c.candidates.slice(0, 10)) {
        const truncated =
          candidate.content.length > 60
            ? candidate.content.slice(0, 60) + "..."
            : candidate.content
        lines.push(
          `| ${candidate.rank} | ${candidate.score.toFixed(4)} | ${truncated} | ${candidate.sources.join(", ")} |`,
        )
      }
      lines.push("")
    }

    lines.push("**Metrics:**")
    lines.push("")
    for (const [key, value] of Object.entries(c.metrics)) {
      lines.push(`- ${key}: ${(value * 100).toFixed(1)}%`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
