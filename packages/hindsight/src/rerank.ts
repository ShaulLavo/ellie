/**
 * Cross-encoder reranking for retrieval results.
 *
 * After RRF fusion produces an initial ranking, a cross-encoder scores each
 * (query, document) pair directly for a significant precision improvement.
 * The user provides their own reranking function (Cohere, Jina, local model, etc).
 */

import type { RerankFunction } from "./types"

/** Sigmoid normalization: cross-encoders return logits which can be negative */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/**
 * Rerank fused candidates using a cross-encoder.
 *
 * 1. Builds document list from candidates using contentMap
 * 2. Calls the user-provided rerank function
 * 3. Sigmoid-normalizes scores to [0, 1]
 * 4. Returns candidates re-sorted by cross-encoder score
 *
 * Candidates without content in the map are dropped (deleted memories).
 */
export async function rerankCandidates(
  rerank: RerankFunction,
  query: string,
  candidates: Array<{ id: string; score: number; sources: string[] }>,
  contentMap: Map<string, string>,
): Promise<Array<{ id: string; score: number; sources: string[] }>> {
  // Filter to candidates with content available
  const withContent = candidates.filter((c) => contentMap.has(c.id))
  if (withContent.length === 0) return []

  const documents = withContent.map((c) => contentMap.get(c.id)!)

  // Call user-provided reranker
  const scores = await rerank(query, documents)

  // Sigmoid-normalize and re-sort
  return withContent
    .map((candidate, i) => ({
      ...candidate,
      score: sigmoid(scores[i]!),
    }))
    .sort((a, b) => b.score - a.score)
}
