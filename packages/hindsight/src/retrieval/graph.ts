/**
 * Meta-Path Forward Push (MPFP) graph retrieval.
 *
 * Replaces the previous type-blind BFS with typed meta-path traversals
 * that follow specific sequences of link types through the heterogeneous
 * memory graph. Enables multi-hop causal chains, cross-type expansions,
 * and semantically meaningful graph exploration.
 *
 * Algorithm:
 *   1. Seed resolution — find memories linked to entities mentioned in query
 *   2. Forward push — for each meta-path, push scores through typed link steps
 *   3. Aggregate — sum scores across all meta-paths (multi-path = stronger signal)
 *   4. Normalize — scale to [0, 1] and return top results
 */

import { eq } from "drizzle-orm"
import type { HindsightDatabase } from "../db"
import type { RetrievalHit } from "./semantic"
import type { MetaPath, LinkType, LinkDirection } from "../types"

// ── Default Meta-Paths ────────────────────────────────────────────────────

export const DEFAULT_META_PATHS: MetaPath[] = [
  // Direct entity expansion (1 hop) — same entities as seeds
  {
    name: "entity-direct",
    steps: [{ linkType: "entity", direction: "both", decay: 0.6 }],
    weight: 1.0,
  },

  // Direct semantic neighbors (1 hop) — similar to seeds
  {
    name: "semantic-direct",
    steps: [{ linkType: "semantic", direction: "both", decay: 0.7 }],
    weight: 0.8,
  },

  // 2-hop forward causal chain — what do seeds cause, and what does that cause?
  {
    name: "causal-chain-forward",
    steps: [
      { linkType: "causes", direction: "forward", decay: 0.7 },
      { linkType: "causes", direction: "forward", decay: 0.5 },
    ],
    weight: 1.2,
  },

  // 2-hop backward causal chain — what caused the seeds, and what caused that?
  {
    name: "causal-chain-backward",
    steps: [
      { linkType: "caused_by", direction: "forward", decay: 0.7 },
      { linkType: "caused_by", direction: "forward", decay: 0.5 },
    ],
    weight: 1.2,
  },

  // Entity → Causal (2 hops) — find entity neighbors, then their causal effects
  {
    name: "entity-then-causal",
    steps: [
      { linkType: "entity", direction: "both", decay: 0.5 },
      { linkType: "causes", direction: "forward", decay: 0.6 },
    ],
    weight: 0.9,
  },

  // Semantic → Entity (2 hops) — broaden semantic via structural expansion
  {
    name: "semantic-then-entity",
    steps: [
      { linkType: "semantic", direction: "both", decay: 0.6 },
      { linkType: "entity", direction: "both", decay: 0.4 },
    ],
    weight: 0.7,
  },

  // What do seeds enable?
  {
    name: "enables-forward",
    steps: [{ linkType: "enables", direction: "forward", decay: 0.6 }],
    weight: 1.0,
  },

  // What do seeds prevent?
  {
    name: "prevents-forward",
    steps: [{ linkType: "prevents", direction: "forward", decay: 0.6 }],
    weight: 1.0,
  },
]

// ── Seed Resolution ───────────────────────────────────────────────────────

/**
 * Find seed memory IDs from entity name matches in the query.
 * Uses word-boundary regex for precision.
 */
function resolveSeedMemories(
  hdb: HindsightDatabase,
  bankId: string,
  query: string,
): Map<string, number> {
  const { schema } = hdb

  const allEntities = hdb.db
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.bankId, bankId))
    .all()

  const seedEntities = allEntities.filter((e) => {
    if (e.name.length < 2) return false
    const escaped = e.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`\\b${escaped}\\b`, "i").test(query)
  })

  if (seedEntities.length === 0) return new Map()

  const seeds = new Map<string, number>()
  for (const entity of seedEntities) {
    const junctions = hdb.db
      .select()
      .from(schema.memoryEntities)
      .where(eq(schema.memoryEntities.entityId, entity.id))
      .all()
    for (const j of junctions) {
      seeds.set(j.memoryId, 1.0)
    }
  }

  return seeds
}

// ── Batched Link Fetching ─────────────────────────────────────────────────

interface LinkRow {
  sourceId: string
  targetId: string
  weight: number
}

/** Max IDs per SQL IN-clause to stay within SQLite limits */
const CHUNK_SIZE = 500

/**
 * Batch-fetch links of a given type connected to frontier node IDs.
 * Uses raw SQL with IN-clauses for performance, respecting direction.
 */
function fetchLinks(
  hdb: HindsightDatabase,
  bankId: string,
  nodeIds: string[],
  linkType: LinkType,
  direction: LinkDirection,
): LinkRow[] {
  if (nodeIds.length === 0) return []

  const results: LinkRow[] = []

  for (let i = 0; i < nodeIds.length; i += CHUNK_SIZE) {
    const chunk = nodeIds.slice(i, i + CHUNK_SIZE)
    const placeholders = chunk.map(() => "?").join(", ")

    let sql: string
    let params: string[]

    if (direction === "forward") {
      sql = `SELECT source_id, target_id, weight FROM hs_memory_links
             WHERE bank_id = ? AND link_type = ? AND source_id IN (${placeholders})`
      params = [bankId, linkType, ...chunk]
    } else if (direction === "backward") {
      sql = `SELECT source_id, target_id, weight FROM hs_memory_links
             WHERE bank_id = ? AND link_type = ? AND target_id IN (${placeholders})`
      params = [bankId, linkType, ...chunk]
    } else {
      sql = `SELECT source_id, target_id, weight FROM hs_memory_links
             WHERE bank_id = ? AND link_type = ?
               AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))`
      params = [bankId, linkType, ...chunk, ...chunk]
    }

    const rows = hdb.sqlite.prepare(sql).all(...params) as Array<{
      source_id: string
      target_id: string
      weight: number
    }>

    for (const row of rows) {
      results.push({
        sourceId: row.source_id,
        targetId: row.target_id,
        weight: row.weight,
      })
    }
  }

  return results
}

// ── Meta-Path Walker ──────────────────────────────────────────────────────

/**
 * Walk a single meta-path from the seed set, pushing scores forward
 * through each step. Returns nodes reached at the final step with
 * their accumulated scores.
 */
function walkMetaPath(
  hdb: HindsightDatabase,
  bankId: string,
  seeds: Map<string, number>,
  metaPath: MetaPath,
): Map<string, number> {
  let frontier = new Map(seeds)

  for (const step of metaPath.steps) {
    const nodeIds = Array.from(frontier.keys())
    if (nodeIds.length === 0) break

    const links = fetchLinks(hdb, bankId, nodeIds, step.linkType, step.direction)
    const nextFrontier = new Map<string, number>()
    const decay = step.decay ?? 0.5

    for (const link of links) {
      let sourceNodeId: string
      let neighborId: string

      if (step.direction === "forward") {
        sourceNodeId = link.sourceId
        neighborId = link.targetId
      } else if (step.direction === "backward") {
        sourceNodeId = link.targetId
        neighborId = link.sourceId
      } else {
        // "both" — the node in the frontier is the source
        if (frontier.has(link.sourceId)) {
          sourceNodeId = link.sourceId
          neighborId = link.targetId
        } else {
          sourceNodeId = link.targetId
          neighborId = link.sourceId
        }
      }

      const frontierScore = frontier.get(sourceNodeId)
      if (frontierScore == null) continue

      const newScore = frontierScore * link.weight * decay
      const existing = nextFrontier.get(neighborId) ?? 0
      nextFrontier.set(neighborId, Math.max(existing, newScore))
    }

    frontier = nextFrontier
  }

  return frontier
}

// ── Main Entry Point ──────────────────────────────────────────────────────

/**
 * MPFP graph retrieval: typed meta-path traversal over the memory graph.
 *
 * 1. Find seed memories from entity mentions in query
 * 2. Run all meta-paths from seeds, pushing scores forward
 * 3. Aggregate scores across paths (sum — multi-path = stronger signal)
 * 4. Normalize to [0, 1], return top results
 */
export function searchGraph(
  hdb: HindsightDatabase,
  bankId: string,
  query: string,
  limit: number,
): RetrievalHit[] {
  // Phase 1: Seed resolution
  const seeds = resolveSeedMemories(hdb, bankId, query)
  if (seeds.size === 0) return []

  // Phase 2 + 3: Run meta-paths and aggregate
  const aggregated = new Map<string, number>()

  // Seeds get base score
  for (const [id, score] of seeds) {
    aggregated.set(id, score)
  }

  for (const metaPath of DEFAULT_META_PATHS) {
    const pathResults = walkMetaPath(hdb, bankId, seeds, metaPath)
    const pathWeight = metaPath.weight ?? 1.0

    for (const [nodeId, score] of pathResults) {
      const current = aggregated.get(nodeId) ?? 0
      aggregated.set(nodeId, current + score * pathWeight)
    }
  }

  // Phase 4: Normalize to [0, 1]
  let maxScore = 0
  for (const score of aggregated.values()) {
    if (score > maxScore) maxScore = score
  }
  if (maxScore === 0) return []

  return Array.from(aggregated.entries())
    .map(([id, score]) => ({
      id,
      score: score / maxScore,
      source: "graph",
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
