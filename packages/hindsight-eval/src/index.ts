export { runBaseline } from "./runner"
export { scoreCase } from "./scoring"
export { generateReport, formatMarkdownReport } from "./report"

export type {
  Scenario,
  EvalCase,
  EvalRunConfig,
  EvalCaseResult,
  EvalReport,
  ScenarioSummary,
  RecallCandidate,
  SeedFact,
} from "./types"
