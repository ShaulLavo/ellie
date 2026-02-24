#!/usr/bin/env bun
/**
 * Phase 2 Verification Runner Script
 *
 * Usage:
 *   bun run scripts/run-phase2-verification.ts [--output-dir=<path>] [--run-id=<id>]
 *
 * Execution sequence:
 * 1. Run Gates 1-5 via bun test
 * 2. Generate and freeze datasets
 * 3. Run metric evaluation (Gates 6-7 data collection)
 * 4. Produce verification artifacts
 */

import { execSync } from "child_process"
import { join, resolve } from "path"
import { runPhase2Verification } from "../src/phase2-runner"

// ── Parse args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const outputDirArg = args.find((a) => a.startsWith("--output-dir="))
const runIdArg = args.find((a) => a.startsWith("--run-id="))

const defaultOutputDir = resolve(import.meta.dir, "..", "artifacts", "phase2")
const outputDirVal = outputDirArg?.split("=")[1]?.trim()
const outputDir = outputDirVal ? resolve(outputDirVal) : defaultOutputDir

const runIdVal = runIdArg?.split("=")[1]?.trim()
const runId = runIdVal || `run-${Date.now()}`

// ── Get git SHA ──────────────────────────────────────────────────────────

let gitSha = "unknown"
try {
  gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim()
} catch {
  // Not in a git repo
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("=" .repeat(60))
  console.log("Phase 2 Verification Runner")
  console.log("=" .repeat(60))
  console.log(`Output: ${outputDir}`)
  console.log(`Run ID: ${runId}`)
  console.log(`Git SHA: ${gitSha}`)
  console.log("")

  // Step 1: Run Gates 1-5 via bun test
  console.log("[Step 1] Running Gate 1-5 tests...")
  const hindsightDir = resolve(import.meta.dir, "..", "..", "hindsight")
  try {
    execSync(
      `bun test --bail ${join(hindsightDir, "src/test/phase2-gate1-routing.test.ts")} ${join(hindsightDir, "src/test/phase2-gate2-conflict.test.ts")} ${join(hindsightDir, "src/test/phase2-gate3-side-effects.test.ts")} ${join(hindsightDir, "src/test/phase2-gate4-episodes.test.ts")} ${join(hindsightDir, "src/test/phase2-gate5-api.test.ts")}`,
      {
        stdio: "inherit",
        timeout: 120_000,
      },
    )
    console.log("[Step 1] All Gate 1-5 tests passed.")
  } catch {
    console.error("[Step 1] Gate 1-5 tests FAILED.")
    process.exit(1)
  }

  // Step 2: Run metric evaluation
  console.log("")
  console.log("[Step 2] Running metric evaluation (Gates 6-7)...")
  const run = await runPhase2Verification({
    outputDir,
    runId,
    gitSha,
    gateTestsPassed: true,
  })

  console.log("")
  console.log("=" .repeat(60))
  console.log("Phase 2 Verification Complete")
  console.log("=" .repeat(60))
  console.log("")
  console.log("Gate Results:")
  for (const gate of run.gates) {
    const icon = gate.status === "pass" ? "[PASS]" : gate.status === "fail" ? "[FAIL]" : "[SKIP]"
    console.log(`  ${icon} ${gate.gate}: ${gate.description}`)
  }
  console.log("")
  console.log("Metrics:")
  if (run.metrics.duplicateRatio) {
    console.log(`  Duplicate Ratio: ${(run.metrics.duplicateRatio.duplicateRatio * 100).toFixed(2)}%`)
  }
  if (run.metrics.narrativeAccuracy) {
    console.log(`  Narrative Accuracy: ${(run.metrics.narrativeAccuracy.accuracy * 100).toFixed(2)}%`)
  }
  console.log("")
  console.log(`Artifacts written to: ${outputDir}`)
}

main().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
