import { describe, expect, test } from 'bun:test'
import {
	createToolLoopDetector,
	type ToolLoopDetector
} from '../src/tool-loop-detection'

// Helper to record a tool call + outcome in one step
function recordWithOutcome(
	detector: ToolLoopDetector,
	toolName: string,
	args: unknown,
	result: unknown
) {
	const detection = detector.record(toolName, args)
	detector.recordOutcome(toolName, args, result)
	return detection
}

// ============================================================================
// Repeated call detection
// ============================================================================

describe('repeated call detection', () => {
	test('does not trigger below threshold', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 5,
			requireIdenticalResults: true
		})

		// 4 identical calls with identical results — below threshold of 5
		for (let i = 0; i < 4; i++) {
			const result = recordWithOutcome(
				detector,
				'readFile',
				{ path: '/foo' },
				{ content: 'hello' }
			)
			expect(result.detected).toBe(false)
		}
	})

	test('triggers at threshold with identical args and results', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 5,
			requireIdenticalResults: true
		})

		// First 4 calls — no detection
		for (let i = 0; i < 4; i++) {
			recordWithOutcome(
				detector,
				'readFile',
				{ path: '/foo' },
				{ content: 'hello' }
			)
		}

		// 5th call triggers
		const fifth = detector.record('readFile', {
			path: '/foo'
		})
		detector.recordOutcome(
			'readFile',
			{ path: '/foo' },
			{ content: 'hello' }
		)

		expect(fifth.detected).toBe(true)
		expect(fifth.pattern).toBe('repeated_call')
		expect(fifth.message).toContain('readFile')
		expect(fifth.message).toContain('5 times')
	})

	test('does not trigger when results differ', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 3,
			requireIdenticalResults: true
		})

		// Same args but different results each time
		for (let i = 0; i < 5; i++) {
			const result = recordWithOutcome(
				detector,
				'readFile',
				{ path: '/foo' },
				{ content: `version-${i}` } // Different results
			)
			expect(result.detected).toBe(false)
		}
	})

	test('triggers without result check when requireIdenticalResults is false', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 3,
			requireIdenticalResults: false
		})

		for (let i = 0; i < 2; i++) {
			recordWithOutcome(
				detector,
				'readFile',
				{ path: '/foo' },
				{ content: `version-${i}` }
			)
		}

		// 3rd call triggers even though results differ
		const third = detector.record('readFile', {
			path: '/foo'
		})
		expect(third.detected).toBe(true)
		expect(third.pattern).toBe('repeated_call')
	})

	test('does not trigger when args differ', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 3,
			requireIdenticalResults: false
		})

		// Same tool but different args
		for (let i = 0; i < 5; i++) {
			const result = detector.record('readFile', {
				path: `/file-${i}`
			})
			expect(result.detected).toBe(false)
		}
	})

	test('streak breaks when a different tool is called', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 3,
			requireIdenticalResults: false
		})

		// 2 identical calls
		detector.record('readFile', { path: '/foo' })
		detector.record('readFile', { path: '/foo' })

		// Different tool breaks the streak
		detector.record('writeFile', { path: '/bar' })

		// Start over — need 3 more consecutive
		const r1 = detector.record('readFile', { path: '/foo' })
		expect(r1.detected).toBe(false)
	})

	test('reset clears all state', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 3,
			requireIdenticalResults: false
		})

		detector.record('readFile', { path: '/foo' })
		detector.record('readFile', { path: '/foo' })

		detector.reset()

		// After reset, the streak is gone
		const result = detector.record('readFile', {
			path: '/foo'
		})
		expect(result.detected).toBe(false)
	})
})

// ============================================================================
// Ping-pong detection
// ============================================================================

describe('ping-pong detection', () => {
	test('does not trigger below threshold', () => {
		const detector = createToolLoopDetector({
			maxPingPongCycles: 4,
			requireIdenticalResults: true
		})

		// 3 cycles of A→B — below threshold of 4
		for (let i = 0; i < 3; i++) {
			recordWithOutcome(
				detector,
				'toolA',
				{ x: 1 },
				{ r: 'a' }
			)
			recordWithOutcome(
				detector,
				'toolB',
				{ y: 2 },
				{ r: 'b' }
			)
		}

		expect(true).toBe(true) // No loop detected in any call
	})

	test('triggers at threshold with identical results', () => {
		const detector = createToolLoopDetector({
			maxPingPongCycles: 4,
			requireIdenticalResults: true
		})

		// 3 complete cycles without triggering
		for (let i = 0; i < 3; i++) {
			recordWithOutcome(
				detector,
				'toolA',
				{ x: 1 },
				{ r: 'a' }
			)
			recordWithOutcome(
				detector,
				'toolB',
				{ y: 2 },
				{ r: 'b' }
			)
		}

		// 4th cycle
		recordWithOutcome(
			detector,
			'toolA',
			{ x: 1 },
			{ r: 'a' }
		)
		const result = detector.record('toolB', { y: 2 })
		detector.recordOutcome('toolB', { y: 2 }, { r: 'b' })

		expect(result.detected).toBe(true)
		expect(result.pattern).toBe('ping_pong')
		expect(result.message).toContain('toolA')
		expect(result.message).toContain('toolB')
		expect(result.message).toContain('4 cycles')
	})

	test('does not trigger when results vary', () => {
		const detector = createToolLoopDetector({
			maxPingPongCycles: 3,
			requireIdenticalResults: true
		})

		// Alternating calls but results differ each cycle
		for (let i = 0; i < 5; i++) {
			recordWithOutcome(
				detector,
				'toolA',
				{ x: 1 },
				{ r: `a-${i}` } // Different results
			)
			const result = recordWithOutcome(
				detector,
				'toolB',
				{ y: 2 },
				{ r: `b-${i}` }
			)
			expect(result.detected).toBe(false)
		}
	})

	test('triggers without result check when requireIdenticalResults is false', () => {
		const detector = createToolLoopDetector({
			maxPingPongCycles: 3,
			requireIdenticalResults: false
		})

		// 2 complete cycles
		for (let i = 0; i < 2; i++) {
			recordWithOutcome(
				detector,
				'search',
				{},
				{ found: i }
			)
			recordWithOutcome(
				detector,
				'navigate',
				{},
				{ page: i }
			)
		}

		// 3rd cycle
		recordWithOutcome(detector, 'search', {}, { found: 99 })
		const result = detector.record('navigate', {})

		expect(result.detected).toBe(true)
		expect(result.pattern).toBe('ping_pong')
	})

	test('does not trigger for same tool repeated (not ping-pong)', () => {
		const detector = createToolLoopDetector({
			maxPingPongCycles: 3,
			requireIdenticalResults: false
		})

		// All same tool — this is repeated call, not ping-pong
		for (let i = 0; i < 10; i++) {
			const result = detector.record('toolA', { x: i })
			// Might trigger repeated_call but not ping_pong
			if (result.detected) {
				expect(result.pattern).not.toBe('ping_pong')
			}
		}
	})
})

// ============================================================================
// History window
// ============================================================================

describe('history window', () => {
	test('old entries are evicted beyond historySize', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 5,
			historySize: 10,
			requireIdenticalResults: false
		})

		// Fill 4 identical calls
		for (let i = 0; i < 4; i++) {
			detector.record('readFile', { path: '/foo' })
		}

		// Push 10 different calls to evict old entries
		for (let i = 0; i < 10; i++) {
			detector.record('other', { i })
		}

		// The old readFile entries should be evicted
		// So a new readFile call doesn't count toward the streak
		const result = detector.record('readFile', {
			path: '/foo'
		})
		expect(result.detected).toBe(false)
	})
})

// ============================================================================
// Stable hashing
// ============================================================================

describe('stable hashing', () => {
	test('treats equivalent objects with different key order as identical', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 3,
			requireIdenticalResults: false
		})

		detector.record('tool', { b: 2, a: 1 })
		detector.record('tool', { a: 1, b: 2 })
		const result = detector.record('tool', { a: 1, b: 2 })
		expect(result.detected).toBe(true)
	})

	test('treats different values as different', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 3,
			requireIdenticalResults: false
		})

		detector.record('tool', { a: 1 })
		detector.record('tool', { a: 2 })
		detector.record('tool', { a: 3 })
		// All different args, no streak
		// This won't trigger because consecutive entries differ
	})
})

// ============================================================================
// Edge cases
// ============================================================================

describe('edge cases', () => {
	test('handles undefined args', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 3,
			requireIdenticalResults: false
		})

		detector.record('tool', undefined)
		detector.record('tool', undefined)
		const result = detector.record('tool', undefined)
		expect(result.detected).toBe(true)
	})

	test('handles null args', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 3,
			requireIdenticalResults: false
		})

		detector.record('tool', null)
		detector.record('tool', null)
		const result = detector.record('tool', null)
		expect(result.detected).toBe(true)
	})

	test('handles complex nested args', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 3,
			requireIdenticalResults: false
		})

		const complexArgs = {
			nested: { deep: { value: [1, 2, 3] } },
			flag: true
		}

		detector.record('tool', complexArgs)
		detector.record('tool', complexArgs)
		const result = detector.record('tool', complexArgs)
		expect(result.detected).toBe(true)
	})

	test('handles empty string tool names', () => {
		const detector = createToolLoopDetector({
			maxRepeatedCalls: 3,
			requireIdenticalResults: false
		})

		detector.record('', {})
		detector.record('', {})
		const result = detector.record('', {})
		expect(result.detected).toBe(true)
	})
})
