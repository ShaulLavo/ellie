/**
 * Deterministic eval runner for Hindsight recall quality.
 *
 * Pipeline: load fixture → seed memories → execute recall → collect candidates → score.
 *
 * Reproducibility knobs:
 * - Hash-based deterministic embeddings (not semantically meaningful)
 * - Stable sort tie-breakers (score DESC, content ASC)
 * - Fixed topK (default 10)
 * - UTC timestamps in outputs
 */

import { tmpdir } from 'os'
import { join } from 'path'
import { readFileSync, rmSync } from 'fs'
import { Hindsight } from '@ellie/hindsight'
import type { RecallOptions } from '@ellie/hindsight'
import { scoreCase } from './scoring'
import {
	hashEmbed,
	createNoopAdapter
} from './eval-helpers'
import type {
	EvalCase,
	EvalRunConfig,
	EvalCaseResult,
	RecallCandidate
} from './types'

const EVAL_EMBED_DIMS = 16

function deterministicEmbed(
	text: string
): Promise<number[]> {
	return Promise.resolve(hashEmbed(text, EVAL_EMBED_DIMS))
}

export function loadFixture(path: string): EvalCase[] {
	const raw = readFileSync(path, 'utf-8')
	const lines = raw
		.trim()
		.split('\n')
		.filter(line => line.trim().length > 0)
	return lines.map((line, i) => {
		try {
			return JSON.parse(line) as EvalCase
		} catch {
			throw new Error(
				`Invalid JSON at ${path} line ${i + 1}: ${line.slice(0, 100)}`
			)
		}
	})
}

export interface RunBaselineOptions {
	config: EvalRunConfig
	/** Override embedding function (for tests with real embeddings) */
	embed?: (text: string) => Promise<number[]>
	/** Override embedding dimensions */
	embeddingDimensions?: number
}

/**
 * Run the full eval pipeline:
 * 1. Load fixture
 * 2. For each case: create fresh DB, seed memories, run recall, score
 * 3. Return all case results
 */
export async function runBaseline(
	options: RunBaselineOptions
): Promise<EvalCaseResult[]> {
	const { config, embed, embeddingDimensions } = options
	const cases = loadFixture(config.datasetPath)
	const results: EvalCaseResult[] = []

	for (let caseIdx = 0; caseIdx < cases.length; caseIdx++) {
		const evalCase = cases[caseIdx]!
		const result = await runSingleCase(
			evalCase,
			caseIdx,
			config,
			embed ?? deterministicEmbed,
			embeddingDimensions ?? EVAL_EMBED_DIMS
		)
		results.push(result)
	}

	return results
}

async function runSingleCase(
	evalCase: EvalCase,
	caseIndex: number,
	config: EvalRunConfig,
	embed: (text: string) => Promise<number[]>,
	embeddingDimensions: number
): Promise<EvalCaseResult> {
	const dbPath = join(
		tmpdir(),
		`hindsight-eval-${Date.now()}-${caseIndex}.db`
	)

	const hs = new Hindsight({
		dbPath,
		embed,
		embeddingDimensions,
		adapter: createNoopAdapter()
	})

	try {
		const startTime = Date.now()

		// Create bank
		const bank = hs.createBank(`eval-bank-${caseIndex}`)
		const bankId = bank.id
		// Seed memories using pre-extracted facts (bypasses LLM)
		const baseTimestamp = new Date(
			'2025-01-01T00:00:00Z'
		).getTime()
		const facts = evalCase.seedFacts.map((fact, i) => ({
			content: fact.content,
			factType: fact.factType,
			confidence: fact.confidence ?? 1.0,
			occurredStart:
				fact.occurredStart ?? baseTimestamp + i * 60_000,
			occurredEnd: fact.occurredEnd ?? null,
			entities: fact.entities ?? [],
			tags: fact.tags ?? []
		}))

		await hs.retain(bankId, 'eval seed content', {
			facts,
			consolidate: false,
			dedupThreshold: 0
		})

		// Execute recall
		const topK = evalCase.constraints?.topK ?? config.topK
		const recallOptions: RecallOptions = {
			limit: topK,
			maxTokens: evalCase.constraints?.tokenBudget,
			enableTrace: true
		}

		const recallResult = await hs.recall(
			bankId,
			evalCase.query,
			recallOptions
		)

		// Collect candidates with stable tie-breaking: (score DESC, id ASC)
		const candidates: RecallCandidate[] =
			recallResult.memories
				.map(scored => ({
					memoryId: scored.memory.id,
					content: scored.memory.content,
					score: scored.score,
					rank: 0,
					sources: [...scored.sources],
					factType: scored.memory.factType
				}))
				.sort((a, b) => {
					if (b.score !== a.score) return b.score - a.score
					// Tie-break on content (deterministic) rather than memoryId (ULID, timestamp-dependent)
					return a.content.localeCompare(b.content)
				})
				.map((c, idx) => ({ ...c, rank: idx + 1 }))

		const durationMs = Date.now() - startTime

		// Score
		const metrics = scoreCase(evalCase, candidates)

		return {
			caseId: evalCase.id,
			scenario: evalCase.scenario,
			query: evalCase.query,
			candidates,
			durationMs,
			metrics
		}
	} finally {
		hs.close()
		try {
			rmSync(dbPath, { force: true })
			rmSync(dbPath + '-wal', { force: true })
			rmSync(dbPath + '-shm', { force: true })
		} catch {
			// cleanup best-effort
		}
	}
}
