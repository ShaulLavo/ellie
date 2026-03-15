/**
 * Mock adapters and stub implementations for tests.
 *
 * Split from setup.ts — provides the mockEmbed function backed by
 * pre-generated real embeddings with a hash-based fallback.
 */

import {
	EMBEDDING_FIXTURE,
	EMBED_DIMS
} from './setup-fixtures'

/**
 * Hash-based fallback embedding (NOT semantically meaningful).
 * Used when a text is not found in the pre-generated fixture.
 */
function hashEmbed(text: string, dims: number): number[] {
	const vec = Array.from<number>({ length: dims }).fill(0)
	for (let i = 0; i < text.length; i++) {
		vec[i % dims] += text.charCodeAt(i) / 1000
	}
	const norm = Math.sqrt(
		vec.reduce((s: number, v: number) => s + v * v, 0)
	)
	return norm > 0 ? vec.map((v: number) => v / norm) : vec
}

/**
 * Embedding function backed by pre-generated real embeddings.
 *
 * With the fixture loaded (default):
 * - Returns real nomic-embed-text vectors for known strings
 * - Cosine similarity between "Peter" and "Peter works at Acme Corp" is high
 * - Semantic search and graph seed resolution work correctly
 *
 * Without fixture or for unknown strings:
 * - Falls back to deterministic hash-based embeddings
 * - Same text → same vector, but similarity is not semantically meaningful
 */
export function mockEmbed(text: string): Promise<number[]> {
	const precomputed = EMBEDDING_FIXTURE[text]
	if (precomputed) {
		return Promise.resolve(precomputed)
	}
	return Promise.resolve(hashEmbed(text, EMBED_DIMS))
}
