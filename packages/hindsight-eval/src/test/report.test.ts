import { describe, it, expect } from 'bun:test'
import { generateReport, formatMarkdownReport } from '../report'
import type { EvalCaseResult, EvalRunConfig } from '../types'

const mockConfig: EvalRunConfig = {
	datasetPath: '/test/fixture.jsonl',
	mode: 'hybrid',
	seed: 42,
	topK: 10,
	outputDir: '/test/output'
}

function makeCaseResult(
	caseId: string,
	scenario: EvalCaseResult['scenario'],
	metrics: Record<string, number>
): EvalCaseResult {
	return {
		caseId,
		scenario,
		query: 'test query',
		candidates: [],
		durationMs: 10,
		metrics
	}
}

describe('report', () => {
	describe('generateReport', () => {
		it('computes per-scenario averages', () => {
			const cases: EvalCaseResult[] = [
				makeCaseResult('fur-1', 'follow_up_recall', { mrr: 0.8, 'recall@1': 1.0 }),
				makeCaseResult('fur-2', 'follow_up_recall', { mrr: 0.6, 'recall@1': 0.0 })
			]

			const report = generateReport({
				config: mockConfig,
				cases,
				gitSha: 'abc123',
				bunVersion: '1.0.0',
				totalDurationMs: 100
			})

			const scenario = report.scenarios.find(s => s.scenario === 'follow_up_recall')
			expect(scenario).toBeDefined()
			expect(scenario!.metrics.mrr).toBeCloseTo(0.7, 3)
			expect(scenario!.metrics['recall@1']).toBeCloseTo(0.5, 3)
			expect(scenario!.caseCount).toBe(2)
		})

		it('computes weighted global score using primary metrics', () => {
			const cases: EvalCaseResult[] = [
				makeCaseResult('fur-1', 'follow_up_recall', { mrr: 1.0 }),
				makeCaseResult('tn-1', 'temporal_narrative', { orderingAccuracy: 0.5 }),
				makeCaseResult('dc-1', 'dedup_conflict', { contradictionRetrievalRate: 0.8 }),
				makeCaseResult('clr-1', 'code_location_recall', { 'pathRecall@k': 0.9 }),
				makeCaseResult('tbp-1', 'token_budget_packing', { factRetentionRate: 0.7 })
			]

			const report = generateReport({
				config: mockConfig,
				cases,
				gitSha: 'abc123',
				bunVersion: '1.0.0',
				totalDurationMs: 100
			})

			// Weighted average: (0.30*1.0 + 0.20*0.5 + 0.15*0.8 + 0.20*0.9 + 0.15*0.7) / 1.0
			const expected = 0.3 * 1.0 + 0.2 * 0.5 + 0.15 * 0.8 + 0.2 * 0.9 + 0.15 * 0.7
			expect(report.globalScore).toBeCloseTo(expected, 3)
		})

		it('includes run metadata', () => {
			const report = generateReport({
				config: mockConfig,
				cases: [],
				gitSha: 'abc123',
				bunVersion: '1.0.0',
				totalDurationMs: 100
			})

			expect(report.runMetadata.gitSha).toBe('abc123')
			expect(report.runMetadata.bunVersion).toBe('1.0.0')
			expect(report.runMetadata.seed).toBe(42)
			expect(report.runMetadata.topK).toBe(10)
			expect(report.version).toBe('1.0.0')
			expect(report.datasetVersion).toBe('assistant-baseline.v1')
		})

		it('does not re-normalize global score for partial scenarios', () => {
			const cases: EvalCaseResult[] = [
				makeCaseResult('fur-1', 'follow_up_recall', { mrr: 1.0 }),
				makeCaseResult('tn-1', 'temporal_narrative', { orderingAccuracy: 1.0 })
			]

			const report = generateReport({
				config: mockConfig,
				cases,
				gitSha: 'abc123',
				bunVersion: '1.0.0',
				totalDurationMs: 100
			})

			// With no re-normalization: 0.30*1.0 + 0.20*1.0 = 0.50 (not 1.0)
			expect(report.globalScore).toBeCloseTo(0.5, 3)
		})

		it('adds warning when scenario families are missing', () => {
			const cases: EvalCaseResult[] = [makeCaseResult('fur-1', 'follow_up_recall', { mrr: 1.0 })]

			const report = generateReport({
				config: mockConfig,
				cases,
				gitSha: 'abc123',
				bunVersion: '1.0.0',
				totalDurationMs: 100
			})

			expect(report.warnings).toBeDefined()
			expect(report.warnings!.length).toBe(1)
			expect(report.warnings![0]).toContain('Partial dataset')
			expect(report.warnings![0]).toContain('1/5 families')
		})

		it('has no warnings when all scenario families are present', () => {
			const cases: EvalCaseResult[] = [
				makeCaseResult('fur-1', 'follow_up_recall', { mrr: 1.0 }),
				makeCaseResult('tn-1', 'temporal_narrative', { orderingAccuracy: 1.0 }),
				makeCaseResult('dc-1', 'dedup_conflict', { contradictionRetrievalRate: 1.0 }),
				makeCaseResult('clr-1', 'code_location_recall', { 'pathRecall@k': 1.0 }),
				makeCaseResult('tbp-1', 'token_budget_packing', { factRetentionRate: 1.0 })
			]

			const report = generateReport({
				config: mockConfig,
				cases,
				gitSha: 'abc123',
				bunVersion: '1.0.0',
				totalDurationMs: 100
			})

			expect(report.warnings).toBeUndefined()
		})

		it('sorts scenarios in deterministic order', () => {
			const cases: EvalCaseResult[] = [
				makeCaseResult('tbp-1', 'token_budget_packing', { factRetentionRate: 1.0 }),
				makeCaseResult('fur-1', 'follow_up_recall', { mrr: 1.0 }),
				makeCaseResult('dc-1', 'dedup_conflict', { contradictionRetrievalRate: 1.0 })
			]

			const report = generateReport({
				config: mockConfig,
				cases,
				gitSha: 'abc123',
				bunVersion: '1.0.0',
				totalDurationMs: 100
			})

			const scenarioOrder = report.scenarios.map(s => s.scenario)
			expect(scenarioOrder).toEqual(['follow_up_recall', 'dedup_conflict', 'token_budget_packing'])
		})
	})

	describe('formatMarkdownReport', () => {
		it('produces valid markdown', () => {
			const report = generateReport({
				config: mockConfig,
				cases: [makeCaseResult('fur-1', 'follow_up_recall', { mrr: 0.8, 'recall@1': 1.0 })],
				gitSha: 'abc123',
				bunVersion: '1.0.0',
				totalDurationMs: 100
			})

			const md = formatMarkdownReport(report)

			expect(md).toContain('# Hindsight Eval Baseline Report')
			expect(md).toContain('**Dataset:** assistant-baseline.v1')
			expect(md).toContain('**Seed:** 42')
			expect(md).toContain('## Global Score:')
			expect(md).toContain('## Scenario Results')
			expect(md).toContain('## Case Details')
			expect(md).toContain('fur-1')
		})

		it('annotates penalty metrics in scenario tables', () => {
			const report = generateReport({
				config: mockConfig,
				cases: [
					makeCaseResult('dc-1', 'dedup_conflict', {
						duplicateLeakRate: 0.5,
						contradictionRetrievalRate: 1.0
					})
				],
				gitSha: 'abc123',
				bunVersion: '1.0.0',
				totalDurationMs: 100
			})

			const md = formatMarkdownReport(report)
			expect(md).toContain('duplicateLeakRate (lower is better)')
			expect(md).not.toContain('contradictionRetrievalRate (lower is better)')
		})

		it('shows warnings in markdown when present', () => {
			const report = generateReport({
				config: mockConfig,
				cases: [makeCaseResult('fur-1', 'follow_up_recall', { mrr: 0.8 })],
				gitSha: 'abc123',
				bunVersion: '1.0.0',
				totalDurationMs: 100
			})

			const md = formatMarkdownReport(report)
			expect(md).toContain('> **Warning:**')
			expect(md).toContain('Partial dataset')
		})

		it('includes scenario weight table', () => {
			const report = generateReport({
				config: mockConfig,
				cases: [],
				gitSha: 'abc123',
				bunVersion: '1.0.0',
				totalDurationMs: 100
			})

			const md = formatMarkdownReport(report)
			expect(md).toContain('### Scenario Weights')
			expect(md).toContain('follow_up_recall')
			expect(md).toContain('30%')
		})
	})
})
