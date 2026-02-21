/**
 * Cognitive scoring module (ACT-R inspired).
 *
 * Deterministic scorer that combines:
 * - Probe activation (semantic similarity)
 * - Base-level activation (access recency + frequency)
 * - Spreading activation (1-hop graph neighbors)
 *
 * Formula:
 *   cognitive_score = 0.50*probe + 0.35*base + 0.15*spread
 *
 * Tie-break: (cognitive_score DESC, memory_id ASC)
 */

import type { HindsightDatabase } from "../db"
import { inArray } from "drizzle-orm"
import { clamp } from "../util"

// ── Constants ──────────────────────────────────────────────────────────────

/** Decay time constant: 7 days in milliseconds */
const TAU_MS = 604_800_000

// ── Types ──────────────────────────────────────────────────────────────────

export interface CognitiveCandidate {
  id: string
  /** Semantic similarity score from candidate generation [0, 1] */
  semanticSimilarity: number
  /** Number of times this memory has been recalled */
  accessCount: number
  /** Epoch ms of last access (null for never-accessed) */
  lastAccessed: number | null
  /** Encoding strength from repeated recall [1.0, 3.0], multiplies base activation */
  encodingStrength: number
}

export interface CognitiveScored {
  id: string
  cognitiveScore: number
  probe: number
  base: number
  spread: number
}

interface LinkRow {
  sourceId: string
  targetId: string
  weight: number
}

// ── Pure scoring helpers ───────────────────────────────────────────────────

/**
 * Probe activation: power-law transform of semantic similarity.
 * Higher exponent (1.35) sharpens the discrimination between candidates.
 */
export function computeProbe(semanticSimilarity: number): number {
  return clamp(semanticSimilarity, 0, 1) ** 1.35
}

/**
 * Base-level activation: frequency × recency × encoding strength.
 * Models ACT-R base-level learning equation (simplified).
 * Returns 0 when lastAccessed is null (never accessed).
 *
 * encodingStrength [1.0, 3.0] is a multiplier that grows with repeated
 * recall, amplifying the base activation of well-rehearsed memories.
 */
export function computeBase(
  accessCount: number,
  lastAccessed: number | null,
  now: number,
  encodingStrength: number = 1.0,
): number {
  if (lastAccessed == null) return 0
  const timeDelta = Math.max(0, now - lastAccessed)
  return encodingStrength * Math.log1p(accessCount) * Math.exp(-timeDelta / TAU_MS)
}

/**
 * Spreading activation via 1-hop neighbors.
 * For each linked candidate in the pool, adds link_weight × source_activation.
 * Normalized via 1 - exp(-raw) to bound in [0, 1).
 */
export function computeSpread(
  candidateId: string,
  sourceActivations: Map<string, number>,
  neighborLinks: LinkRow[],
): number {
  let raw = 0
  for (const link of neighborLinks) {
    const neighborId =
      link.sourceId === candidateId ? link.targetId : link.sourceId
    const neighborActivation = sourceActivations.get(neighborId)
    if (neighborActivation != null) {
      raw += link.weight * neighborActivation
    }
  }
  return 1 - Math.exp(-raw)
}

/**
 * Combined cognitive score.
 * Weights: probe=0.50, base=0.35, spread=0.15
 */
export function computeCognitiveScore(
  probe: number,
  base: number,
  spread: number,
): number {
  return 0.5 * probe + 0.35 * base + 0.15 * spread
}

// ── Main scorer ────────────────────────────────────────────────────────────

/**
 * Score and rank candidates using cognitive (ACT-R) model.
 *
 * 1. Compute probe + base per candidate → source_activation
 * 2. Load 1-hop links between candidates from hs_memory_links
 * 3. Compute spread per candidate
 * 4. Combine: 0.50*probe + 0.35*base + 0.15*spread
 * 5. Sort by (cognitiveScore DESC, id ASC)
 */
export function scoreCognitive(
  hdb: HindsightDatabase,
  candidates: CognitiveCandidate[],
  now: number,
): CognitiveScored[] {
  if (candidates.length === 0) return []

  // Step 1: Compute probe and base per candidate → source activation
  //
  // Source activation determines how much a node "radiates" to its neighbors
  // via spreading activation. The weights (0.7 probe + 0.3 base) are intentionally
  // different from the final output weights (0.50/0.35/0.15) — in ACT-R, how much
  // a node radiates is dominated by its relevance to the query (probe), while the
  // final score incorporates retrieval history (base) more heavily. Clamped to [0,1]
  // so spread normalization via 1-exp(-x) stays well-behaved.
  const probeMap = new Map<string, number>()
  const baseMap = new Map<string, number>()
  const sourceActivations = new Map<string, number>()

  for (const c of candidates) {
    const probe = computeProbe(c.semanticSimilarity)
    const base = computeBase(c.accessCount, c.lastAccessed, now, c.encodingStrength)
    probeMap.set(c.id, probe)
    baseMap.set(c.id, base)
    sourceActivations.set(c.id, clamp(0.7 * probe + 0.3 * base, 0, 1))
  }

  // Step 2: Load 1-hop links between candidates
  const candidateIds = candidates.map((c) => c.id)
  const links = loadNeighborLinks(hdb, candidateIds)

  // Step 3: Build per-candidate link index and compute spread
  const linksByCandidate = new Map<string, LinkRow[]>()
  for (const link of links) {
    const sourceLinks = linksByCandidate.get(link.sourceId) ?? []
    sourceLinks.push(link)
    linksByCandidate.set(link.sourceId, sourceLinks)

    const targetLinks = linksByCandidate.get(link.targetId) ?? []
    targetLinks.push(link)
    linksByCandidate.set(link.targetId, targetLinks)
  }

  // Step 4: Combine scores
  const results: CognitiveScored[] = candidates.map((c) => {
    const probe = probeMap.get(c.id)!
    const base = baseMap.get(c.id)!
    const candidateLinks = linksByCandidate.get(c.id) ?? []
    const spread = computeSpread(c.id, sourceActivations, candidateLinks)
    const cognitiveScore = computeCognitiveScore(probe, base, spread)

    return { id: c.id, cognitiveScore, probe, base, spread }
  })

  // Step 5: Deterministic sort: score DESC, id ASC
  results.sort((a, b) => {
    if (b.cognitiveScore !== a.cognitiveScore) {
      return b.cognitiveScore - a.cognitiveScore
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  return results
}

// ── DB helpers ─────────────────────────────────────────────────────────────

/**
 * Load all links where BOTH source and target are in the candidate set.
 * These are the 1-hop neighbors within the candidate pool.
 *
 * Queries both sourceId and targetId IN candidateIds to capture edges
 * regardless of storage direction, then filters to only intra-pool edges.
 */
function loadNeighborLinks(
  hdb: HindsightDatabase,
  candidateIds: string[],
): LinkRow[] {
  if (candidateIds.length === 0) return []

  const idSet = new Set(candidateIds)

  // Query links where source is in candidate set
  const bySource = hdb.db
    .select({
      sourceId: hdb.schema.memoryLinks.sourceId,
      targetId: hdb.schema.memoryLinks.targetId,
      weight: hdb.schema.memoryLinks.weight,
    })
    .from(hdb.schema.memoryLinks)
    .where(inArray(hdb.schema.memoryLinks.sourceId, candidateIds))
    .all()
    .filter((link) => idSet.has(link.targetId))

  // Query links where target is in candidate set (captures reverse edges)
  const byTarget = hdb.db
    .select({
      sourceId: hdb.schema.memoryLinks.sourceId,
      targetId: hdb.schema.memoryLinks.targetId,
      weight: hdb.schema.memoryLinks.weight,
    })
    .from(hdb.schema.memoryLinks)
    .where(inArray(hdb.schema.memoryLinks.targetId, candidateIds))
    .all()
    .filter((link) => idSet.has(link.sourceId))

  // Deduplicate (a link found by both queries should appear once)
  const seen = new Set<string>()
  const result: LinkRow[] = []
  for (const link of [...bySource, ...byTarget]) {
    const key = `${link.sourceId}:${link.targetId}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(link)
    }
  }
  return result
}
