/**
 * Shared utilities for Hindsight eval runners.
 *
 * - hashEmbed: deterministic hash-based embedding (NOT semantically meaningful)
 * - createNoopAdapter: minimal LLM adapter that yields empty responses
 */

import type { HindsightConfig } from '@ellie/hindsight'

// ── Deterministic embedding ───────────────────────────────────────────────

/**
 * Hash-based embedding for deterministic eval/test runs.
 * NOT semantically meaningful — produces consistent vectors for identical text.
 *
 * @param positionWeighted When true, multiplies each char code by (i+1) to
 *   differentiate anagrams (e.g. "ab" vs "ba"). Default: false.
 */
export function hashEmbed(
	text: string,
	dims: number,
	positionWeighted = false
): number[] {
	const vec = Array.from<number>({ length: dims }).fill(0)
	for (let i = 0; i < text.length; i++) {
		const weight = positionWeighted ? i + 1 : 1
		vec[i % dims]! += (text.charCodeAt(i) * weight) / 1000
	}
	const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
	return norm > 0 ? vec.map(v => v / norm) : vec
}

// ── Noop adapter ──────────────────────────────────────────────────────────

/**
 * Minimal mock adapter for eval — retain uses pre-extracted facts so
 * the LLM is never called. Required by the Hindsight constructor.
 */
export function createNoopAdapter(): HindsightConfig['adapter'] {
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
			return Promise.resolve({
				data: {},
				rawResponse: '{}'
			})
		}
	} as unknown as NonNullable<HindsightConfig['adapter']>
}
