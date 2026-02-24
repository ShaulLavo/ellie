#!/usr/bin/env bun
/**
 * Phase 2 — Gate 8: Reproducibility Check
 *
 * Runs the full verification suite twice from clean state and compares
 * non-timing metrics for exact match.
 *
 * Usage:
 *   bun run scripts/phase2-repro-check.ts [--output-dir=<path>]
 */

import { resolve, join } from "path"
import { mkdirSync, writeFileSync } from "fs"
import { runPhase2Verification } from "../src/phase2-runner"
import { generateReproducibilityReport } from "../src/phase2-report"
import { execSync } from "child_process"

const args = process.argv.slice(2)
const outputDirArg = args.find((a) => a.startsWith("--output-dir="))

const outputDir = outputDirArg
  ? resolve(outputDirArg.split("=")[1]!)
  : resolve(import.meta.dir, "..", "artifacts", "phase2")

let gitSha = "unknown"
try {
  gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim()
} catch {
  // Not in a git repo
}

async function main() {
  console.log("=" .repeat(60))
  console.log("Phase 2 Gate 8: Reproducibility Check")
  console.log("=" .repeat(60))
  console.log("")

  mkdirSync(outputDir, { recursive: true })

  // Run A
  console.log("[Run A] Starting first verification run...")
  const runA = await runPhase2Verification({
    outputDir: join(outputDir, "run-a"),
    runId: "a",
    gitSha,
  })
  console.log("[Run A] Complete.")
  console.log("")

  // Run B
  console.log("[Run B] Starting second verification run...")
  const runB = await runPhase2Verification({
    outputDir: join(outputDir, "run-b"),
    runId: "b",
    gitSha,
  })
  console.log("[Run B] Complete.")
  console.log("")

  // Compare
  const { pass, report } = generateReproducibilityReport(runA, runB)

  // Write artifacts
  writeFileSync(join(outputDir, "phase2_repro_run_a.json"), JSON.stringify(runA, null, 2))
  writeFileSync(join(outputDir, "phase2_repro_run_b.json"), JSON.stringify(runB, null, 2))
  writeFileSync(join(outputDir, "phase2_reproducibility_report.md"), report)

  console.log("=" .repeat(60))
  console.log(`Gate 8 Result: ${pass ? "PASS" : "FAIL"}`)
  console.log("=" .repeat(60))
  console.log("")
  console.log(`Full report: ${join(outputDir, "phase2_reproducibility_report.md")}`)

  process.exit(pass ? 0 : 1)
}

main().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
