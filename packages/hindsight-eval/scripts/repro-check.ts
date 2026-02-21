#!/usr/bin/env bun
/**
 * Reproducibility check: run the baseline twice and verify identical metrics.
 *
 * Usage:
 *   bun run eval:baseline:repro
 *
 * Exits 0 if reproducible, 1 if metrics differ.
 */

import { resolve, join } from "path"
import { readFileSync, existsSync } from "fs"
import { runBaseline } from "../src/runner"
import { generateReport } from "../src/report"
import type { EvalRunConfig, EvalReport } from "../src/types"

const PKG_ROOT = resolve(import.meta.dir, "..")
const DEFAULT_FIXTURE = join(PKG_ROOT, "fixtures", "assistant-baseline.v1.jsonl")
const LATEST_DIR = join(PKG_ROOT, "artifacts", "eval", "baseline", "latest")

// ── Config ────────────────────────────────────────────────────────────────

const config: EvalRunConfig = {
  datasetPath: DEFAULT_FIXTURE,
  mode: "hybrid",
  seed: 42,
  topK: 10,
  outputDir: "",
}

// ── Run 1 ─────────────────────────────────────────────────────────────────

console.log("Hindsight Eval Reproducibility Check")
console.log("======================================")
console.log("")

console.log("Run 1 of 2...")
const startRun1 = Date.now()
const casesRun1 = await runBaseline({ config })
const duration1 = Date.now() - startRun1
console.log(`  Completed in ${duration1}ms`)

// ── Run 2 ─────────────────────────────────────────────────────────────────

console.log("Run 2 of 2...")
const startRun2 = Date.now()
const casesRun2 = await runBaseline({ config })
const duration2 = Date.now() - startRun2
console.log(`  Completed in ${duration2}ms`)

// ── Compare runs ──────────────────────────────────────────────────────────

console.log("")
console.log("Comparing runs...")

let allMatch = true
const TIMING_TOLERANCE = 0 // quality metrics must be exact

if (casesRun1.length !== casesRun2.length) {
  console.error(`  MISMATCH: case count differs: ${casesRun1.length} vs ${casesRun2.length}`)
  allMatch = false
}

for (let i = 0; i < Math.min(casesRun1.length, casesRun2.length); i++) {
  const r1 = casesRun1[i]!
  const r2 = casesRun2[i]!

  if (r1.caseId !== r2.caseId) {
    console.error(`  MISMATCH: case order differs at index ${i}: ${r1.caseId} vs ${r2.caseId}`)
    allMatch = false
    continue
  }

  // Compare candidate order (quality metric)
  if (r1.candidates.length !== r2.candidates.length) {
    console.error(`  MISMATCH [${r1.caseId}]: candidate count ${r1.candidates.length} vs ${r2.candidates.length}`)
    allMatch = false
  } else {
    for (let j = 0; j < r1.candidates.length; j++) {
      const c1 = r1.candidates[j]!
      const c2 = r2.candidates[j]!
      if (c1.content !== c2.content) {
        console.error(`  MISMATCH [${r1.caseId}]: candidate ${j} content differs`)
        allMatch = false
        break
      }
      if (Math.abs(c1.score - c2.score) > 1e-10) {
        console.error(`  MISMATCH [${r1.caseId}]: candidate ${j} score ${c1.score} vs ${c2.score}`)
        allMatch = false
        break
      }
    }
  }

  // Compare metrics (must be exact for quality metrics)
  const metricKeys = new Set([
    ...Object.keys(r1.metrics),
    ...Object.keys(r2.metrics),
  ])
  for (const key of metricKeys) {
    const v1 = r1.metrics[key] ?? 0
    const v2 = r2.metrics[key] ?? 0
    if (Math.abs(v1 - v2) > TIMING_TOLERANCE) {
      console.error(`  MISMATCH [${r1.caseId}]: metric ${key} = ${v1} vs ${v2}`)
      allMatch = false
    }
  }
}

// ── Optional: compare against committed baseline ──────────────────────────

let baselineMatch = true
const baselineJsonPath = join(LATEST_DIR, "results.json")
if (existsSync(baselineJsonPath)) {
  console.log("")
  console.log("Comparing against committed baseline...")

  const baseline = JSON.parse(
    readFileSync(baselineJsonPath, "utf-8"),
  ) as EvalReport

  if (casesRun1.length !== baseline.cases.length) {
    console.warn(`  WARNING: case count differs: ${casesRun1.length} (current) vs ${baseline.cases.length} (baseline)`)
    baselineMatch = false
  }

  for (let i = 0; i < Math.min(casesRun1.length, baseline.cases.length); i++) {
    const current = casesRun1[i]!
    const committed = baseline.cases[i]!

    if (current.caseId !== committed.caseId) {
      console.error(`  BASELINE MISMATCH: case order differs at ${i}`)
      baselineMatch = false
      continue
    }

    const metricKeys = new Set([
      ...Object.keys(current.metrics),
      ...Object.keys(committed.metrics),
    ])
    for (const key of metricKeys) {
      const v1 = current.metrics[key] ?? 0
      const v2 = committed.metrics[key] ?? 0
      // Tolerance accounts for rounding in the serialized baseline (6 decimal places)
      if (Math.abs(v1 - v2) > 1e-5) {
        console.error(
          `  BASELINE MISMATCH [${current.caseId}]: ${key} = ${v1} (current) vs ${v2} (committed)`,
        )
        baselineMatch = false
      }
    }
  }

  if (baselineMatch) {
    console.log("  All metrics match committed baseline.")
  }
} else {
  console.log("")
  console.error("ERROR: No committed baseline found at:", LATEST_DIR)
  console.error("Run `bun run eval:baseline` first to generate one.")
  baselineMatch = false
}

// ── Result ────────────────────────────────────────────────────────────────

console.log("")
if (allMatch) {
  console.log("PASS: Both runs produced identical quality metrics.")
  if (!baselineMatch) {
    console.error("FAIL: Baseline comparison failed (missing or differs).")
    process.exit(1)
  }
  process.exit(0)
} else {
  console.error("FAIL: Runs produced different quality metrics.")
  process.exit(1)
}
