#!/usr/bin/env bun
/**
 * Run the baseline eval and generate reports.
 *
 * Usage:
 *   bun run eval:baseline
 *   bun run eval:baseline -- --output-dir ./artifacts/eval/baseline/custom
 */

import { resolve, join, relative } from 'path'
import { mkdirSync, writeFileSync, existsSync, cpSync, rmSync } from 'fs'
import { runBaseline } from '../src/runner'
import { generateReport, formatMarkdownReport, PRIMARY_METRIC } from '../src/report'
import type { EvalRunConfig } from '../src/types'

const PKG_ROOT = resolve(import.meta.dir, '..')
const DEFAULT_FIXTURE = join(PKG_ROOT, 'fixtures', 'assistant-baseline.v1.jsonl')
const DEFAULT_OUTPUT_DIR = join(PKG_ROOT, 'artifacts', 'eval', 'baseline')

// Parse CLI args
const args = process.argv.slice(2)
const outputDirArg = args.indexOf('--output-dir')
const outputDir =
	outputDirArg >= 0 && args[outputDirArg + 1] ? resolve(args[outputDirArg + 1]) : DEFAULT_OUTPUT_DIR

// ── Run ───────────────────────────────────────────────────────────────────

const config: EvalRunConfig = {
	datasetPath: DEFAULT_FIXTURE,
	mode: 'hybrid',
	seed: 42,
	topK: 10,
	outputDir
}

console.log('Hindsight Eval Baseline Runner')
console.log('================================')
console.log(`Dataset: ${config.datasetPath}`)
console.log(`Mode: ${config.mode}`)
console.log(`Seed: ${config.seed}`)
console.log(`Top-K: ${config.topK}`)
console.log(`Output: ${outputDir}`)
console.log('')

const startTime = Date.now()

console.log('Running baseline eval...')
const cases = await runBaseline({ config })

const totalDurationMs = Date.now() - startTime
console.log(`Completed ${cases.length} cases in ${totalDurationMs}ms`)

// ── Get metadata ──────────────────────────────────────────────────────────

let gitSha = 'unknown'
try {
	const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'])
	gitSha = new TextDecoder().decode(proc.stdout).trim()
} catch {
	// not in a git repo
}

const bunVersion = Bun.version

// ── Generate report ───────────────────────────────────────────────────────

// Store relative paths in the committed report (relative to package root)
const reportConfig: EvalRunConfig = {
	...config,
	datasetPath: relative(PKG_ROOT, config.datasetPath),
	outputDir: relative(PKG_ROOT, config.outputDir)
}

const report = generateReport({
	config: reportConfig,
	cases,
	gitSha,
	bunVersion,
	totalDurationMs
})

// ── Write output ──────────────────────────────────────────────────────────

const dateDir = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const runDir = join(outputDir, dateDir)
mkdirSync(runDir, { recursive: true })

const jsonPath = join(runDir, 'results.json')
const mdPath = join(runDir, 'summary.md')

writeFileSync(jsonPath, JSON.stringify(report, null, 2))
writeFileSync(mdPath, formatMarkdownReport(report))

// Update latest snapshot
const latestDir = join(outputDir, 'latest')
if (existsSync(latestDir)) {
	rmSync(latestDir, { recursive: true, force: true })
}
mkdirSync(latestDir, { recursive: true })
cpSync(runDir, latestDir, { recursive: true })

console.log('')
console.log('Output:')
console.log(`  JSON: ${jsonPath}`)
console.log(`  Markdown: ${mdPath}`)
console.log(`  Latest: ${latestDir}`)
console.log('')
console.log(`Global Score: ${(report.globalScore * 100).toFixed(1)}%`)
console.log('')
console.log('Per-scenario scores:')
for (const scenario of report.scenarios) {
	const primaryKey = PRIMARY_METRIC[scenario.scenario] ?? Object.keys(scenario.metrics)[0] ?? '?'
	const primaryValue = scenario.metrics[primaryKey] ?? 0
	console.log(
		`  ${scenario.scenario}: ${(primaryValue * 100).toFixed(1)}% (${primaryKey}, ${scenario.caseCount} cases)`
	)
}
