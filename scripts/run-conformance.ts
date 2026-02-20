#!/usr/bin/env bun
/**
 * Runs conformance tests and outputs a JSON summary.
 *
 * Usage:
 *   bun scripts/run-conformance.ts [client|server|all]
 *
 * Output includes a __CONFORMANCE_RESULT__ line per suite with:
 *   { type, passed, failed, skipped, total, failures: [{suite, test, error}] }
 */
import { $ } from "bun"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync, unlinkSync } from "node:fs"

const target = process.argv[2] ?? `all`

interface ConformanceResult {
  type: string
  passed: number
  failed: number
  skipped: number
  total: number
  durationMs: number
  failures: { suite: string; test: string; error: string }[]
}

function parseJunitXml(xml: string): Omit<ConformanceResult, "type"> {
  let passed = 0
  let failed = 0
  let skipped = 0
  const failures: { suite: string; test: string; error: string }[] = []

  // Extract total time from root testsuites element
  const timeMatch = xml.match(/<testsuites[^>]*\stime="([^"]*)"/)
  const durationMs = timeMatch ? Math.round(parseFloat(timeMatch[1]) * 1000) : 0

  // Find all testcase elements
  const testcaseRegex =
    /<testcase\s+name="([^"]*)"[^>]*classname="([^"]*)"[^>]*(?:\/>|>([\s\S]*?)<\/testcase>)/g
  let match: RegExpExecArray | null

  while ((match = testcaseRegex.exec(xml)) !== null) {
    const testName = decodeXmlEntities(match[1])
    const suiteName = decodeXmlEntities(match[2])
    const body = match[3] ?? ``

    if (body.includes(`<skipped`)) {
      skipped++
    } else if (body.includes(`<failure`)) {
      failed++
      const errorMatch = body.match(
        /<failure[^>]*(?:message="([^"]*)")?[^>]*>([\s\S]*?)<\/failure>/
      )
      failures.push({
        suite: suiteName,
        test: testName,
        error: errorMatch
          ? decodeXmlEntities(errorMatch[1] ?? errorMatch[2] ?? ``)
          : `unknown error`,
      })
    } else {
      passed++
    }
  }

  return { passed, failed, skipped, total: passed + failed + skipped, durationMs, failures }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, `&`)
    .replace(/&lt;/g, `<`)
    .replace(/&gt;/g, `>`)
    .replace(/&quot;/g, `"`)
    .replace(/&#39;/g, `'`)
}

async function runServerConformance(): Promise<ConformanceResult> {
  const junitFile = join(tmpdir(), `conformance-server-${Date.now()}.xml`)

  try {
    await $`bun test apps/app/test/conformance.test.ts --reporter=junit --reporter-outfile=${junitFile}`
      .quiet()
      .nothrow()
    const xml = readFileSync(junitFile, `utf-8`)
    const result = parseJunitXml(xml)
    return { type: `server`, ...result }
  } finally {
    try {
      unlinkSync(junitFile)
    } catch {}
  }
}

async function runClientConformance(): Promise<ConformanceResult> {
  const junitFile = join(tmpdir(), `conformance-client-${Date.now()}.xml`)

  try {
    const proc =
      await $`bun test packages/streams-client/test/conformance.test.ts --reporter=junit --reporter-outfile=${junitFile}`
        .quiet()
        .nothrow()
    // Client test has its own detailed runner - parse stdout for __CONFORMANCE_RESULT__
    const stdout = proc.stdout.toString()
    const resultLine = stdout
      .split(`\n`)
      .find((l) => l.includes(`__CONFORMANCE_RESULT__`))

    if (resultLine) {
      const json = resultLine.split(`__CONFORMANCE_RESULT__`)[1]!.trim()
      return JSON.parse(json) as ConformanceResult
    }

    // Fallback to junit parsing
    const xml = readFileSync(junitFile, `utf-8`)
    const result = parseJunitXml(xml)
    return { type: `client`, ...result }
  } finally {
    try {
      unlinkSync(junitFile)
    } catch {}
  }
}

const results: ConformanceResult[] = []

if (target === `server` || target === `all`) {
  const result = await runServerConformance()
  results.push(result)
  console.log(`__CONFORMANCE_RESULT__ ${JSON.stringify(result)}`)
}

if (target === `client` || target === `all`) {
  const result = await runClientConformance()
  results.push(result)
  console.log(`__CONFORMANCE_RESULT__ ${JSON.stringify(result)}`)
}

// Final combined summary
const totalPassed = results.reduce((s, r) => s + r.passed, 0)
const totalFailed = results.reduce((s, r) => s + r.failed, 0)
const totalSkipped = results.reduce((s, r) => s + r.skipped, 0)
const totalTests = results.reduce((s, r) => s + r.total, 0)
const allFailures = results.flatMap((r) => r.failures)

console.log(
  `\n__CONFORMANCE_SUMMARY__ ${JSON.stringify({
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    total: totalTests,
    failures: allFailures,
  })}`
)

process.exit(totalFailed > 0 ? 1 : 0)
