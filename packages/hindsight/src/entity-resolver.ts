/**
 * Multi-factor entity resolution.
 *
 * Ported from the original Hindsight's 3-factor scoring:
 * 1. Name similarity (Dice coefficient) — weight 0.5
 * 2. Co-occurring entities — weight 0.3
 * 3. Temporal proximity — weight 0.2
 */

import type { EntityRow } from "./schema"

export interface ResolvedEntity {
  entityId: string
  isNew: boolean
}

const MATCH_THRESHOLD = 0.6

/**
 * Attempt to resolve a name to an existing entity using multi-factor scoring.
 *
 * Returns null if no candidate exceeds the threshold — caller should create a new entity.
 */
export function resolveEntity(
  name: string,
  _entityType: string,
  existingEntities: EntityRow[],
  cooccurrences: Map<string, Set<string>>,
  nearbyEntityNames: string[],
  now: number,
): ResolvedEntity | null {
  let bestScore = 0
  let bestEntity: EntityRow | null = null

  for (const candidate of existingEntities) {
    let score = 0

    // Factor 1: Name similarity (weight 0.5)
    const nameSim = stringSimilarity(
      name.toLowerCase(),
      candidate.name.toLowerCase(),
    )
    score += nameSim * 0.5

    // Factor 2: Co-occurring entities (weight 0.3)
    score += cooccurrenceScore(candidate.id, existingEntities, cooccurrences, nearbyEntityNames) * 0.3

    // Factor 3: Temporal proximity (weight 0.2) — decay over 7 days
    const daysDiff = Math.abs(now - candidate.lastUpdated) / 86_400_000
    if (daysDiff < 7) {
      score += Math.max(0, 1 - daysDiff / 7) * 0.2
    }

    if (score > bestScore) {
      bestScore = score
      bestEntity = candidate
    }
  }

  if (bestScore >= MATCH_THRESHOLD && bestEntity) {
    return { entityId: bestEntity.id, isNew: false }
  }
  return null
}

/**
 * Score based on co-occurring entity overlap (0–1).
 */
function cooccurrenceScore(
  candidateId: string,
  existingEntities: EntityRow[],
  cooccurrences: Map<string, Set<string>>,
  nearbyEntityNames: string[],
): number {
  if (nearbyEntityNames.length === 0) return 0

  const candidateCoocs = cooccurrences.get(candidateId) ?? new Set()
  const nearbyIds = nearbyEntityNames
    .map(
      (n) =>
        existingEntities.find(
          (e) => e.name.toLowerCase() === n.toLowerCase(),
        )?.id,
    )
    .filter(Boolean) as string[]

  if (nearbyIds.length === 0) return 0

  const overlap = nearbyIds.filter((id) => candidateCoocs.has(id)).length
  return overlap / nearbyEntityNames.length
}

/**
 * Dice coefficient (bigram overlap): fast approximate string similarity.
 *
 * Returns value in [0, 1] where 1 = identical strings.
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0

  const bigrams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.substring(i, i + 2)
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1)
  }

  let matches = 0
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.substring(i, i + 2)
    const count = bigrams.get(bigram) ?? 0
    if (count > 0) {
      bigrams.set(bigram, count - 1)
      matches++
    }
  }

  return (2 * matches) / (a.length + b.length - 2)
}
