/**
 * Phase 2 Verification — Runner
 *
 * Orchestrates the full verification pipeline:
 * 1. Run unit/integration tests for Gates 1-5 (delegated to bun test)
 * 2. Generate and freeze datasets
 * 3. Run baseline metrics on Phase 1 commit
 * 4. Run candidate metrics on Phase 2 branch
 * 5. Compare and evaluate Gates 6-7
 * 6. Rerun for Gate 8 (reproducibility)
 * 7. Produce final verification report
 */

import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { Hindsight } from '@ellie/hindsight'
import type { HindsightConfig } from '@ellie/hindsight'
import {
	generateRollingIngestDataset,
	generateTemporalNarrativeDataset,
	toJsonl
} from './phase2-dataset-gen'
import {
	computeDuplicateRatio,
	evaluateGate6,
	computeNarrativeAccuracy,
	evaluateGate7
} from './phase2-metrics'
import { generateVerificationRunJson, generateComparisonReport } from './phase2-report'
import type {
	GateResult,
	Phase2ComparisonReport,
	Phase2VerificationRun,
	RollingIngestEvent
} from './phase2-types'

// ── Constants ────────────────────────────────────────────────────────────

const EVAL_EMBED_DIMS = 16
const DATASET_SEED = 42

// ── Deterministic embedding ─────────────────────────────────────────────

function deterministicEmbed(text: string): Promise<number[]> {
	const vec = Array.from<number>({ length: EVAL_EMBED_DIMS }).fill(0)
	for (let i = 0; i < text.length; i++) {
		// Incorporate character position to differentiate anagrams (e.g. "ab" vs "ba")
		vec[i % EVAL_EMBED_DIMS]! += (text.charCodeAt(i) * (i + 1)) / 1000
	}
	const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
	return Promise.resolve(norm > 0 ? vec.map((v) => v / norm) : vec)
}

function createNoopAdapter(): HindsightConfig['adapter'] {
	return {
		kind: 'text' as const,
		name: 'eval-noop',
		model: 'eval-noop',
		chatStream() {
			return {
				async *[Symbol.asyncIterator]() {
					yield {
						type: 'TEXT_MESSAGE_START' as const,
						messageId: 'eval',
						timestamp: Date.now(),
						model: 'eval-noop'
					}
					yield {
						type: 'TEXT_MESSAGE_CONTENT' as const,
						messageId: 'eval',
						delta: '{}',
						timestamp: Date.now(),
						model: 'eval-noop'
					}
					yield {
						type: 'TEXT_MESSAGE_END' as const,
						messageId: 'eval',
						timestamp: Date.now(),
						model: 'eval-noop'
					}
					yield {
						type: 'RUN_FINISHED' as const,
						runId: 'eval',
						timestamp: Date.now(),
						model: 'eval-noop'
					}
				}
			}
		},
		structuredOutput() {
			return Promise.resolve({ data: {}, rawResponse: '{}' })
		}
	} as unknown as NonNullable<HindsightConfig['adapter']>
}

// ── Ingest Runner ───────────────────────────────────────────────────────

/**
 * Run rolling ingest events through a fresh Hindsight instance and
 * return cluster counts for duplicate ratio computation.
 */
export async function runRollingIngest(events: RollingIngestEvent[]): Promise<{
	clusterCounts: Map<string, number>
	memoryIdsByCluster: Map<string, string[]>
}> {
	const dbPath = join(
		tmpdir(),
		`hindsight-p2-ingest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
	)

	const hs = new Hindsight({
		dbPath,
		embed: deterministicEmbed,
		embeddingDimensions: EVAL_EMBED_DIMS,
		adapter: createNoopAdapter()
	})

	try {
		const bank = hs.createBank('phase2-eval-bank')
		const bankId = bank.id

		// Track memory IDs per cluster
		const memoryIdsByCluster = new Map<string, string[]>()

		for (const event of events) {
			const result = await hs.retain(bankId, event.content, {
				facts: [
					{
						content: event.content,
						factType: event.factType,
						entities: [event.entity],
						tags: event.tags
					}
				],
				consolidate: false,
				dedupThreshold: 0.92,
				profile: event.scope,
				session: event.scope
			})

			const ids = memoryIdsByCluster.get(event.clusterId) ?? []
			for (const mem of result.memories) {
				ids.push(mem.id)
			}
			memoryIdsByCluster.set(event.clusterId, ids)
		}

		// Count canonical memories per cluster
		const clusterCounts = new Map<string, number>()
		for (const [clusterId, ids] of memoryIdsByCluster) {
			// Deduplicated count = unique IDs
			clusterCounts.set(clusterId, new Set(ids).size)
		}

		return { clusterCounts, memoryIdsByCluster }
	} finally {
		hs.close()
		try {
			rmSync(dbPath, { force: true })
			rmSync(dbPath + '-wal', { force: true })
			rmSync(dbPath + '-shm', { force: true })
		} catch {
			// best effort
		}
	}
}

// ── Verification Run ─────────────────────────────────────────────────────

export interface RunPhase2VerificationOptions {
	outputDir: string
	runId: string
	gitSha: string
	/** When true, Gates 1-5 are marked "pass" instead of "skip" (caller verified they passed). */
	gateTestsPassed?: boolean
}

/**
 * Execute a single Phase 2 verification run.
 *
 * This runs the metric evaluation pipeline (Gates 6-7 data collection).
 * Gates 1-5 are handled by bun test (phase2-gate*.test.ts files).
 */
export async function runPhase2Verification(
	options: RunPhase2VerificationOptions
): Promise<Phase2VerificationRun> {
	const { outputDir, runId, gitSha, gateTestsPassed } = options
	mkdirSync(outputDir, { recursive: true })

	const gates: GateResult[] = []

	// Gate 1-5: These are tested via bun test.
	// When gateTestsPassed is set, the caller has already run and verified them.
	const gateStatus = gateTestsPassed ? 'pass' : 'skip'
	for (let i = 1; i <= 5; i++) {
		gates.push({
			gate: `Gate ${i}`,
			status: gateStatus,
			description: `Tested via bun test (phase2-gate${i}-*.test.ts)`,
			details: {}
		})
	}

	// Gate 6: Duplicate Ratio
	console.log('[Phase 2] Generating rolling ingest dataset...')
	const ingestEvents = generateRollingIngestDataset(800, DATASET_SEED)

	// Save dataset
	writeFileSync(join(outputDir, 'rolling_ingest.v1.jsonl'), toJsonl(ingestEvents))

	console.log(`[Phase 2] Running rolling ingest (${ingestEvents.length} events)...`)
	const { clusterCounts } = await runRollingIngest(ingestEvents)
	const drMetrics = computeDuplicateRatio(clusterCounts)

	console.log(`[Phase 2] Duplicate ratio: ${(drMetrics.duplicateRatio * 100).toFixed(2)}%`)

	gates.push({
		gate: 'Gate 6',
		status: 'skip', // Requires baseline comparison
		description: `Duplicate ratio = ${(drMetrics.duplicateRatio * 100).toFixed(2)}% (baseline comparison needed)`,
		details: {
			totalCanonicalCount: drMetrics.totalCanonicalCount,
			totalDuplicates: drMetrics.totalDuplicates,
			duplicateRatio: drMetrics.duplicateRatio
		}
	})

	// Gate 7: Narrative Accuracy
	console.log('[Phase 2] Generating temporal narrative dataset...')
	const narrativeQuestions = generateTemporalNarrativeDataset(
		200,
		ingestEvents.length,
		DATASET_SEED
	)

	// Save dataset
	writeFileSync(join(outputDir, 'temporal_narrative.v1.jsonl'), toJsonl(narrativeQuestions))

	// TODO: Narrative accuracy requires running actual narrative queries
	// against the ingested data, which requires mapping between event IDs
	// and actual memory IDs. This is a placeholder producing zeroed metrics;
	// the full pipeline will be implemented when baseline commit is frozen.
	const narrativeMetrics = computeNarrativeAccuracy([])

	gates.push({
		gate: 'Gate 7',
		status: 'skip',
		description: 'Narrative accuracy (baseline comparison needed)',
		details: {
			totalQuestions: narrativeQuestions.length,
			accuracy: narrativeMetrics.accuracy
		}
	})

	// Gate 8: Reproducibility (deferred to rerun)
	gates.push({
		gate: 'Gate 8',
		status: 'skip',
		description: 'Requires second run for comparison',
		details: {}
	})

	const run: Phase2VerificationRun = {
		timestamp: new Date().toISOString(),
		gitSha,
		runId,
		gates,
		passed: gates.every((g) => g.status !== 'fail'),
		metrics: {
			duplicateRatio: drMetrics,
			narrativeAccuracy: narrativeMetrics
		}
	}

	// Write run output
	writeFileSync(
		join(outputDir, `phase2_verification_${runId}.json`),
		generateVerificationRunJson(run)
	)

	return run
}

// ── Comparison Runner ───────────────────────────────────────────────────

/**
 * Compare baseline and candidate verification runs.
 * Evaluates Gates 6-7 pass/fail based on improvement thresholds.
 */
/** Compare baseline and candidate runs, evaluating Gates 6-7 and producing a comparison report. */
export function compareRuns(
	baseline: Phase2VerificationRun,
	candidate: Phase2VerificationRun
): { report: string; gateResults: GateResult[] } {
	const baselineDR = baseline.metrics.duplicateRatio?.duplicateRatio ?? 0
	const candidateDR = candidate.metrics.duplicateRatio?.duplicateRatio ?? 0
	const baselineAcc = baseline.metrics.narrativeAccuracy?.accuracy ?? 0
	const candidateAcc = candidate.metrics.narrativeAccuracy?.accuracy ?? 0

	const gate6 = evaluateGate6(baselineDR, candidateDR)
	const gate7 = evaluateGate7(baselineAcc, candidateAcc)

	const gateResults: GateResult[] = [
		...candidate.gates.filter(
			(g) =>
				!g.gate.startsWith('Gate 6') && !g.gate.startsWith('Gate 7') && !g.gate.startsWith('Gate 8')
		),
		{
			gate: 'Gate 6',
			status: gate6.pass ? 'pass' : 'fail',
			description: `Duplicate ratio reduction: ${(gate6.reductionPercent * 100).toFixed(1)}% (threshold >= 25%)`,
			details: {
				baselineDR,
				candidateDR,
				reduction: gate6.reduction,
				reductionPercent: gate6.reductionPercent
			}
		},
		{
			gate: 'Gate 7',
			status: gate7.pass ? 'pass' : 'fail',
			description: `Narrative accuracy improvement: ${(gate7.improvementPercent * 100).toFixed(1)}% (threshold >= 15%)`,
			details: {
				baselineAcc,
				candidateAcc,
				improvement: gate7.improvement,
				improvementPercent: gate7.improvementPercent
			}
		},
		{
			gate: 'Gate 8',
			status: 'skip',
			description: 'Reproducibility (requires separate phase2-repro-check.ts run)',
			details: {}
		}
	]

	const comparisonReport: Phase2ComparisonReport = {
		baseline: {
			duplicateRatio: baselineDR,
			narrativeAccuracy: baselineAcc
		},
		candidate: {
			duplicateRatio: candidateDR,
			narrativeAccuracy: candidateAcc
		},
		improvements: {
			duplicateRatioReduction: gate6.reduction,
			duplicateRatioReductionPercent: gate6.reductionPercent,
			narrativeAccuracyImprovement: gate7.improvement,
			narrativeAccuracyImprovementPercent: gate7.improvementPercent
		},
		gate6Pass: gate6.pass,
		gate7Pass: gate7.pass
	}

	const report = generateComparisonReport(comparisonReport, gateResults)
	return { report, gateResults }
}
