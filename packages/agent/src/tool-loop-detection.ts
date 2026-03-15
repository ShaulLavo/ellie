/**
 * Tool loop detection — detects degenerate repeated tool call patterns.
 *
 * Inspired by openclaw's tool-loop-detection.ts:
 * - Sliding window of recent calls
 * - Repeated call detection (same tool + same args + same result)
 * - Ping-pong detection (A→B→A→B with stable results)
 *
 * Key design decisions:
 * - requireIdenticalResults: true by default (only flag when args AND results match)
 * - On detection: continue, don't terminate — return a warning message for the LLM
 * - Thresholds: maxRepeatedCalls=5, maxPingPongCycles=4 (conservative to avoid false positives)
 * - Uses JSON.stringify with sorted keys instead of sha256 (sufficient for in-memory comparison)
 */

// Types

export type LoopPattern = 'repeated_call' | 'ping_pong'

export interface ToolLoopDetectorOptions {
	/** Same tool+args N times to trigger. Default 5. */
	maxRepeatedCalls: number
	/** A→B→A→B cycles to trigger. Default 4. */
	maxPingPongCycles: number
	/** Sliding window size. Default 30. */
	historySize: number
	/** Only flag as loop if results are also identical. Default true. */
	requireIdenticalResults: boolean
}

export interface LoopDetectionResult {
	detected: boolean
	pattern?: LoopPattern
	message?: string
}

export interface ToolLoopDetector {
	/** Record a tool call and check for loops. Called BEFORE execution. */
	record(
		toolName: string,
		args: unknown
	): LoopDetectionResult
	/** Record the outcome of a tool call. Called AFTER execution. */
	recordOutcome(
		toolName: string,
		args: unknown,
		result: unknown
	): void
	/** Reset all state. */
	reset(): void
}

// Internal types

interface ToolCallEntry {
	toolName: string
	argsHash: string
	resultHash?: string
}

// Hash utility

/**
 * Deterministic hash of a value using JSON.stringify with sorted keys.
 * Sufficient for in-memory comparison within a single run.
 */
function stableHash(value: unknown): string {
	try {
		return JSON.stringify(value, sortedReplacer)
	} catch {
		return String(value)
	}
}

/**
 * JSON replacer that sorts object keys for deterministic output.
 */
function sortedReplacer(
	_key: string,
	value: unknown
): unknown {
	if (
		value &&
		typeof value === 'object' &&
		!Array.isArray(value)
	) {
		const sorted: Record<string, unknown> = {}
		for (const k of Object.keys(value).sort((a, b) =>
			a.localeCompare(b)
		)) {
			sorted[k] = (value as Record<string, unknown>)[k]
		}
		return sorted
	}
	return value
}

// Factory

const DEFAULT_OPTIONS: ToolLoopDetectorOptions = {
	maxRepeatedCalls: 5,
	maxPingPongCycles: 4,
	historySize: 30,
	requireIdenticalResults: true
}

// Detection algorithms

function checkRepeatedCalls(
	history: ToolCallEntry[],
	toolName: string,
	argsHash: string,
	config: ToolLoopDetectorOptions
): LoopDetectionResult {
	let streak = 0
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i]
		if (
			entry.toolName === toolName &&
			entry.argsHash === argsHash
		) {
			streak++
		} else {
			break
		}
	}

	if (streak < config.maxRepeatedCalls) {
		return { detected: false }
	}

	if (config.requireIdenticalResults) {
		const streakEntries = history.slice(-streak)
		const withResults = streakEntries.filter(
			e => e.resultHash !== undefined
		)
		if (withResults.length < 2) {
			return { detected: false }
		}
		const allSame = withResults.every(
			e => e.resultHash === withResults[0].resultHash
		)
		if (!allSame) {
			return { detected: false }
		}
	}

	return {
		detected: true,
		pattern: 'repeated_call',
		message: `Loop detected: "${toolName}" has been called ${streak} times with identical arguments${config.requireIdenticalResults ? ' and results' : ''}. Try a different approach or different arguments.`
	}
}

function checkPingPong(
	history: ToolCallEntry[],
	config: ToolLoopDetectorOptions
): LoopDetectionResult {
	if (history.length < config.maxPingPongCycles * 2) {
		return { detected: false }
	}

	const last = history[history.length - 1]
	const secondLast = history[history.length - 2]

	if (
		!secondLast ||
		last.toolName === secondLast.toolName
	) {
		return { detected: false }
	}

	const toolA = secondLast.toolName
	const toolB = last.toolName

	let cycles = 0
	let i = history.length - 1

	while (i >= 1) {
		const current = history[i]
		const prev = history[i - 1]

		if (
			current.toolName === toolB &&
			prev.toolName === toolA
		) {
			cycles++
			i -= 2
		} else {
			break
		}
	}

	if (cycles < config.maxPingPongCycles) {
		return { detected: false }
	}

	if (config.requireIdenticalResults) {
		const tailLength = cycles * 2
		const tailEntries = history.slice(-tailLength)
		const aEntries = tailEntries.filter(
			e =>
				e.toolName === toolA && e.resultHash !== undefined
		)
		const bEntries = tailEntries.filter(
			e =>
				e.toolName === toolB && e.resultHash !== undefined
		)

		if (aEntries.length < 2 || bEntries.length < 2) {
			return { detected: false }
		}

		const aAllSame = aEntries.every(
			e => e.resultHash === aEntries[0].resultHash
		)
		const bAllSame = bEntries.every(
			e => e.resultHash === bEntries[0].resultHash
		)

		if (!aAllSame || !bAllSame) {
			return { detected: false }
		}
	}

	return {
		detected: true,
		pattern: 'ping_pong',
		message: `Loop detected: "${toolA}" and "${toolB}" are being called in an alternating pattern (${cycles} cycles) with no progress. Try a different approach.`
	}
}

// Factory

export function createToolLoopDetector(
	options?: Partial<ToolLoopDetectorOptions>
): ToolLoopDetector {
	const opts: ToolLoopDetectorOptions = {
		...DEFAULT_OPTIONS,
		...options
	}

	let history: ToolCallEntry[] = []

	return {
		record(
			toolName: string,
			args: unknown
		): LoopDetectionResult {
			const argsHash = stableHash(args)
			history.push({ toolName, argsHash })
			if (history.length > opts.historySize) {
				history = history.slice(
					history.length - opts.historySize
				)
			}

			const repeatedResult = checkRepeatedCalls(
				history,
				toolName,
				argsHash,
				opts
			)
			if (repeatedResult.detected) return repeatedResult

			const pingPongResult = checkPingPong(history, opts)
			if (pingPongResult.detected) return pingPongResult

			return { detected: false }
		},

		recordOutcome(
			toolName: string,
			args: unknown,
			result: unknown
		): void {
			const argsHash = stableHash(args)
			const resultHash = stableHash(result)

			for (let i = history.length - 1; i >= 0; i--) {
				const entry = history[i]
				if (
					entry.toolName === toolName &&
					entry.argsHash === argsHash &&
					entry.resultHash === undefined
				) {
					entry.resultHash = resultHash
					break
				}
			}
		},

		reset() {
			history = []
		}
	}
}
