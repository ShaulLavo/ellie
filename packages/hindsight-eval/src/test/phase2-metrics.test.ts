/**
 * Tests for Phase 2 metric computation (Gates 6-7).
 */

import { describe, it, expect } from 'bun:test'
import {
	computeDuplicateRatio,
	evaluateGate6,
	isNarrativeQuestionCorrect,
	computeNarrativeAccuracy,
	evaluateGate7
} from '../phase2-metrics'

// ── Gate 6: Duplicate Ratio ──────────────────────────────────────────────

describe('computeDuplicateRatio', () => {
	it('returns 0 for empty cluster counts', () => {
		const result = computeDuplicateRatio(new Map())
		expect(result.duplicateRatio).toBe(0)
		expect(result.totalCanonicalCount).toBe(0)
		expect(result.totalDuplicates).toBe(0)
	})

	it('returns 0 when all clusters have exactly 1 memory', () => {
		const counts = new Map([
			['c1', 1],
			['c2', 1],
			['c3', 1]
		])
		const result = computeDuplicateRatio(counts)
		expect(result.duplicateRatio).toBe(0)
		expect(result.totalCanonicalCount).toBe(3)
		expect(result.totalDuplicates).toBe(0)
	})

	it('computes correct ratio with duplicates', () => {
		// Cluster 1: 3 memories (2 duplicates)
		// Cluster 2: 1 memory (0 duplicates)
		// Cluster 3: 2 memories (1 duplicate)
		// Total: 6, Duplicates: 3, DR = 3/6 = 0.5
		const counts = new Map([
			['c1', 3],
			['c2', 1],
			['c3', 2]
		])
		const result = computeDuplicateRatio(counts)
		expect(result.totalCanonicalCount).toBe(6)
		expect(result.totalDuplicates).toBe(3)
		expect(result.duplicateRatio).toBe(0.5)
	})

	it('computes correct ratio when all duplicated', () => {
		const counts = new Map([
			['c1', 5],
			['c2', 5]
		])
		const result = computeDuplicateRatio(counts)
		expect(result.totalCanonicalCount).toBe(10)
		expect(result.totalDuplicates).toBe(8) // 4 + 4
		expect(result.duplicateRatio).toBe(0.8) // 8/10
	})
})

describe('evaluateGate6', () => {
	it('passes when reduction >= 25%', () => {
		// Baseline: 0.5, Candidate: 0.3 => reduction = (0.5-0.3)/0.5 = 0.4 = 40%
		const result = evaluateGate6(0.5, 0.3)
		expect(result.pass).toBe(true)
		expect(result.reductionPercent).toBeCloseTo(0.4)
	})

	it('passes at exactly 25% threshold', () => {
		// Baseline: 0.4, Candidate: 0.3 => reduction = (0.4-0.3)/0.4 = 0.25 = 25%
		const result = evaluateGate6(0.4, 0.3)
		expect(result.pass).toBe(true)
		expect(result.reductionPercent).toBeCloseTo(0.25)
	})

	it('fails when reduction < 25%', () => {
		// Baseline: 0.5, Candidate: 0.45 => reduction = (0.5-0.45)/0.5 = 0.1 = 10%
		const result = evaluateGate6(0.5, 0.45)
		expect(result.pass).toBe(false)
		expect(result.reductionPercent).toBeCloseTo(0.1)
	})

	it('fails when baseline is 0 (invalid dataset)', () => {
		const result = evaluateGate6(0, 0)
		expect(result.pass).toBe(false)
	})

	it('fails when candidate is worse than baseline', () => {
		const result = evaluateGate6(0.3, 0.5)
		expect(result.pass).toBe(false)
		expect(result.reductionPercent).toBeLessThan(0)
	})
})

// ── Gate 7: Narrative Accuracy ───────────────────────────────────────────

describe('isNarrativeQuestionCorrect', () => {
	it('returns true for empty expected IDs', () => {
		expect(isNarrativeQuestionCorrect([], ['a', 'b'])).toBe(
			true
		)
	})

	it('returns true when all expected IDs present in correct order', () => {
		expect(
			isNarrativeQuestionCorrect(
				['a', 'b', 'c'],
				['a', 'x', 'b', 'y', 'c']
			)
		).toBe(true)
	})

	it('returns false when expected ID is missing', () => {
		expect(
			isNarrativeQuestionCorrect(
				['a', 'b', 'c'],
				['a', 'b']
			)
		).toBe(false)
	})

	it('returns false when expected IDs are out of order', () => {
		expect(
			isNarrativeQuestionCorrect(
				['a', 'b', 'c'],
				['c', 'b', 'a']
			)
		).toBe(false)
	})

	it('returns false when partially out of order', () => {
		expect(
			isNarrativeQuestionCorrect(['a', 'b'], ['b', 'a'])
		).toBe(false)
	})

	it('returns true with single expected ID present', () => {
		expect(
			isNarrativeQuestionCorrect(['a'], ['x', 'a', 'y'])
		).toBe(true)
	})
})

describe('computeNarrativeAccuracy', () => {
	it('returns 0 for empty results', () => {
		const result = computeNarrativeAccuracy([])
		expect(result.accuracy).toBe(0)
		expect(result.totalQuestions).toBe(0)
	})

	it('returns 1.0 when all correct', () => {
		const results = [
			{ correct: true },
			{ correct: true },
			{ correct: true }
		]
		const result = computeNarrativeAccuracy(results)
		expect(result.accuracy).toBe(1.0)
		expect(result.correctQuestions).toBe(3)
	})

	it('returns 0.5 when half correct', () => {
		const results = [
			{ correct: true },
			{ correct: false },
			{ correct: true },
			{ correct: false }
		]
		const result = computeNarrativeAccuracy(results)
		expect(result.accuracy).toBe(0.5)
	})
})

describe('evaluateGate7', () => {
	it('passes when improvement >= 15%', () => {
		// Baseline: 0.6, Candidate: 0.72 => improvement = (0.72-0.6)/0.6 = 0.2 = 20%
		const result = evaluateGate7(0.6, 0.72)
		expect(result.pass).toBe(true)
		expect(result.improvementPercent).toBeCloseTo(0.2)
	})

	it('passes at exactly 15% threshold', () => {
		// Baseline: 0.8, Candidate: 0.92 => improvement = (0.92-0.8)/0.8 = 0.15 = 15%
		const result = evaluateGate7(0.8, 0.92)
		expect(result.pass).toBe(true)
		expect(result.improvementPercent).toBeCloseTo(0.15)
	})

	it('fails when improvement < 15%', () => {
		// Baseline: 0.8, Candidate: 0.85 => improvement = (0.85-0.8)/0.8 = 0.0625 = 6.25%
		const result = evaluateGate7(0.8, 0.85)
		expect(result.pass).toBe(false)
	})

	it('fails when baseline is 0 (invalid dataset)', () => {
		const result = evaluateGate7(0, 0.5)
		expect(result.pass).toBe(false)
	})

	it('fails when candidate is worse', () => {
		const result = evaluateGate7(0.8, 0.6)
		expect(result.pass).toBe(false)
		expect(result.improvementPercent).toBeLessThan(0)
	})
})
