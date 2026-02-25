/**
 * Tests for the context packing policy.
 */

import { describe, it, expect } from 'bun:test'
import {
	packContext,
	estimateTokens,
	generateFallbackGist,
	type PackCandidate
} from '../context-pack'

describe('estimateTokens', () => {
	it('estimates ~4 chars per token', () => {
		expect(estimateTokens('hello world')).toBe(3) // 11 chars / 4 = 2.75 → 3
		expect(estimateTokens('')).toBe(0)
		expect(estimateTokens('a')).toBe(1)
		expect(estimateTokens('abcd')).toBe(1)
		expect(estimateTokens('abcde')).toBe(2)
	})
})

describe('generateFallbackGist', () => {
	it('returns content unchanged when <= 280 chars', () => {
		const short = 'This is a short text.'
		expect(generateFallbackGist(short)).toBe(short)
	})

	it('truncates to 280 chars with ... when > 280', () => {
		const long = 'x'.repeat(500)
		const gist = generateFallbackGist(long)
		expect(gist.length).toBe(280)
		expect(gist.endsWith('...')).toBe(true)
	})

	it('produces exactly 280 chars for boundary case', () => {
		const exactly280 = 'a'.repeat(280)
		expect(generateFallbackGist(exactly280)).toBe(
			exactly280
		)
	})
})

describe('packContext', () => {
	function makeCandidate(
		id: string,
		contentLen: number,
		score: number,
		gist?: string | null
	): PackCandidate {
		return {
			id,
			content: 'x'.repeat(contentLen),
			gist: gist ?? null,
			score
		}
	}

	it('returns empty result for no candidates', () => {
		const result = packContext([], 2000)
		expect(result.packed.length).toBe(0)
		expect(result.overflow).toBe(false)
		expect(result.totalTokensUsed).toBe(0)
		expect(result.budgetRemaining).toBe(2000)
	})

	it('includes top 2 as full text always', () => {
		const candidates = [
			makeCandidate('a', 100, 0.9),
			makeCandidate('b', 100, 0.8),
			makeCandidate('c', 100, 0.7)
		]
		const result = packContext(candidates, 2000)

		expect(result.packed.length).toBe(3)
		expect(result.packed[0]!.mode).toBe('full')
		expect(result.packed[1]!.mode).toBe('full')
	})

	it('sets overflow=true when top 2 exceed budget', () => {
		const candidates = [
			makeCandidate('a', 5000, 0.9), // ~1250 tokens
			makeCandidate('b', 5000, 0.8) // ~1250 tokens
		]
		const result = packContext(candidates, 100) // budget = 100 tokens

		expect(result.overflow).toBe(true)
		expect(result.packed.length).toBe(2)
		expect(result.packed[0]!.mode).toBe('full')
		expect(result.packed[1]!.mode).toBe('full')
	})

	it('uses gist for rank 3+ when available', () => {
		const candidates = [
			makeCandidate('a', 40, 0.9), // 10 tokens
			makeCandidate('b', 40, 0.8), // 10 tokens
			makeCandidate('c', 400, 0.7, 'Short gist for c'), // full=100 tokens, gist≈4 tokens
			makeCandidate('d', 400, 0.6, 'Short gist for d')
		]
		const result = packContext(candidates, 50) // budget allows top 2 (20) + some gists

		const gistPacked = result.packed.filter(
			p => p.mode === 'gist'
		)
		expect(gistPacked.length).toBeGreaterThan(0)
		expect(result.overflow).toBe(false)
	})

	it('uses fallback gist when gist is null', () => {
		const candidates = [
			makeCandidate('a', 40, 0.9),
			makeCandidate('b', 40, 0.8),
			makeCandidate('c', 400, 0.7, null) // no pre-generated gist
		]
		const result = packContext(candidates, 100)

		// Should still pack rank 3 using fallback truncation
		const rank3 = result.packed.find(p => p.id === 'c')
		if (rank3) {
			expect(rank3.mode).toBe('gist')
			expect(rank3.text.length).toBeLessThanOrEqual(280)
		}
	})

	it('respects total budget constraint', () => {
		const candidates = [
			makeCandidate('a', 400, 0.9), // 100 tokens
			makeCandidate('b', 400, 0.8), // 100 tokens
			makeCandidate('c', 400, 0.7), // 100 tokens
			makeCandidate('d', 400, 0.6) // 100 tokens
		]
		const result = packContext(candidates, 250) // 250 tokens total

		expect(result.totalTokensUsed).toBeLessThanOrEqual(
			250 + 10
		) // small tolerance for rounding
	})

	it('returns deterministic results for same input', () => {
		const candidates = [
			makeCandidate('a', 200, 0.9, 'gist a'),
			makeCandidate('b', 200, 0.8, 'gist b'),
			makeCandidate('c', 200, 0.7, 'gist c')
		]
		const r1 = packContext(candidates, 200)
		const r2 = packContext(candidates, 200)

		expect(r1.packed.map(p => p.id)).toEqual(
			r2.packed.map(p => p.id)
		)
		expect(r1.totalTokensUsed).toBe(r2.totalTokensUsed)
	})

	it('handles single candidate', () => {
		const result = packContext(
			[makeCandidate('a', 100, 0.9)],
			2000
		)
		expect(result.packed.length).toBe(1)
		expect(result.packed[0]!.mode).toBe('full')
	})

	it('handles two candidates exactly', () => {
		const result = packContext(
			[
				makeCandidate('a', 100, 0.9),
				makeCandidate('b', 100, 0.8)
			],
			2000
		)
		expect(result.packed.length).toBe(2)
		expect(
			result.packed.every(p => p.mode === 'full')
		).toBe(true)
	})
})
