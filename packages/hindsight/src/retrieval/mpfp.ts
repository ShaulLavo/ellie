/**
 * MPFP (Meta-Path Forward Push) retrieval utilities.
 *
 * This module provides:
 * - EdgeCache: lazy edge storage with per-node loaded tracking
 * - mpfpTraverseAsync: async forward-push traversal over typed edge patterns
 * - rrfFusion: Reciprocal Rank Fusion over per-pattern score maps
 */

export type MpfpEdgeType =
	| 'semantic'
	| 'temporal'
	| 'entity'
	| 'causes'
	| 'caused_by'
	| 'enables'
	| 'prevents'

export interface EdgeTarget {
	nodeId: string
	weight: number
}

export interface SeedNode {
	nodeId: string
	score: number
}

export interface MpfpConfig {
	alpha: number
	threshold: number
	topKNeighbors: number
}

export interface PatternResult {
	pattern: MpfpEdgeType[]
	scores: Record<string, number>
}

export interface MpfpTraversalResult {
	pattern: MpfpEdgeType[]
	scores: Record<string, number>
}

export type EdgesByType = Partial<
	Record<MpfpEdgeType, Record<string, EdgeTarget[]>>
>

export type LoadAllEdgesForFrontier = (
	frontierNodeIds: string[],
	topKNeighbors: number
) => Promise<EdgesByType>

const DEFAULT_MPFP_CONFIG: MpfpConfig = {
	alpha: 0.15,
	threshold: 1e-6,
	topKNeighbors: 20
}

/**
 * Lazy edge cache keyed by edge type and source node.
 */
export class EdgeCache {
	private readonly edgesByType = new Map<
		MpfpEdgeType,
		Map<string, EdgeTarget[]>
	>()
	private readonly fullyLoaded = new Set<string>()

	addAllEdges(
		edgesByType: EdgesByType,
		loadedNodeIds: string[]
	): void {
		for (const [rawType, bySource] of Object.entries(
			edgesByType
		)) {
			if (!bySource) continue
			const edgeType = rawType as MpfpEdgeType
			const typeMap =
				this.edgesByType.get(edgeType) ??
				new Map<string, EdgeTarget[]>()
			this.edgesByType.set(edgeType, typeMap)

			for (const [sourceId, targets] of Object.entries(
				bySource
			)) {
				const normalized = (targets ?? [])
					.filter(
						target =>
							Number.isFinite(target.weight) &&
							target.weight > 0
					)
					.map(target => ({
						nodeId: target.nodeId,
						weight: target.weight
					}))
					.sort((a, b) => b.weight - a.weight)
				typeMap.set(sourceId, normalized)
			}
		}

		for (const nodeId of loadedNodeIds) {
			this.fullyLoaded.add(nodeId)
		}
	}

	isFullyLoaded(nodeId: string): boolean {
		return this.fullyLoaded.has(nodeId)
	}

	getUncached(nodeIds: string[]): string[] {
		return [...new Set(nodeIds)].filter(
			nodeId => !this.isFullyLoaded(nodeId)
		)
	}

	getNeighbors(
		edgeType: MpfpEdgeType,
		nodeId: string
	): EdgeTarget[] {
		return this.edgesByType.get(edgeType)?.get(nodeId) ?? []
	}

	getNormalizedNeighbors(
		edgeType: MpfpEdgeType,
		nodeId: string,
		topK: number
	): EdgeTarget[] {
		const neighbors = this.getNeighbors(edgeType, nodeId)
			.slice(0, Math.max(0, topK))
			.filter(target => target.weight > 0)
		if (neighbors.length === 0) return []

		const total = neighbors.reduce(
			(sum, target) => sum + target.weight,
			0
		)
		if (total <= 0) return []

		return neighbors.map(target => ({
			nodeId: target.nodeId,
			weight: target.weight / total
		}))
	}
}

/**
 * Async forward push traversal over a typed meta-path pattern.
 *
 * Behavior:
 * - At each hop, deposit alpha mass at current frontier nodes.
 * - Spread remaining mass to normalized neighbors for that edge type.
 * - Lazily load uncached frontier nodes only.
 * - After final hop, deposit remaining mass at terminal frontier nodes.
 */
export async function mpfpTraverseAsync(
	seeds: SeedNode[],
	pattern: MpfpEdgeType[],
	loadAllEdgesForFrontier: LoadAllEdgesForFrontier,
	cache: EdgeCache,
	config: Partial<MpfpConfig> = {}
): Promise<MpfpTraversalResult> {
	if (seeds.length === 0) {
		return { pattern, scores: {} }
	}

	const effective: MpfpConfig = {
		...DEFAULT_MPFP_CONFIG,
		...config
	}
	const scores = new Map<string, number>()
	let frontier = new Map<string, number>()

	for (const seed of seeds) {
		if (!Number.isFinite(seed.score) || seed.score <= 0)
			continue
		frontier.set(
			seed.nodeId,
			(frontier.get(seed.nodeId) ?? 0) + seed.score
		)
	}
	if (frontier.size === 0) {
		return { pattern, scores: {} }
	}

	for (const edgeType of pattern) {
		if (frontier.size === 0) break

		const frontierNodes = [...frontier.keys()]
		const uncached = cache.getUncached(frontierNodes)
		if (uncached.length > 0) {
			const edges = await loadAllEdgesForFrontier(
				uncached,
				effective.topKNeighbors
			)
			cache.addAllEdges(edges, uncached)
		}

		const nextFrontier = new Map<string, number>()
		for (const [nodeId, mass] of frontier.entries()) {
			if (mass < effective.threshold) continue

			const retained = effective.alpha * mass
			scores.set(
				nodeId,
				(scores.get(nodeId) ?? 0) + retained
			)

			const spill = (1 - effective.alpha) * mass
			if (spill < effective.threshold) continue

			propagateMass(
				cache,
				edgeType,
				nodeId,
				spill,
				effective,
				nextFrontier
			)
		}
		frontier = nextFrontier
	}

	// Deposit remaining mass at terminal nodes so final-hop nodes are represented.
	for (const [nodeId, mass] of frontier.entries()) {
		if (mass < effective.threshold) continue
		scores.set(nodeId, (scores.get(nodeId) ?? 0) + mass)
	}

	return {
		pattern,
		scores: Object.fromEntries(scores.entries())
	}
}

function propagateMass(
	cache: EdgeCache,
	edgeType: MpfpEdgeType,
	nodeId: string,
	spill: number,
	config: MpfpConfig,
	nextFrontier: Map<string, number>
): void {
	const neighbors = cache.getNormalizedNeighbors(
		edgeType,
		nodeId,
		config.topKNeighbors
	)
	for (const neighbor of neighbors) {
		const propagated = spill * neighbor.weight
		if (propagated < config.threshold) continue
		nextFrontier.set(
			neighbor.nodeId,
			(nextFrontier.get(neighbor.nodeId) ?? 0) + propagated
		)
	}
}

/**
 * Reciprocal Rank Fusion over pattern score maps.
 *
 * Per pattern:
 * - sort nodes by descending score
 * - add 1 / (k + rank + 1) to each node
 */
export function rrfFusion(
	results: PatternResult[],
	topK: number = 20,
	k: number = 60
): Array<[string, number]> {
	if (results.length === 0 || topK <= 0) return []

	const fused = new Map<string, number>()
	for (const result of results) {
		const entries = Object.entries(result.scores)
			.filter(
				([, score]) => Number.isFinite(score) && score > 0
			)
			.sort((a, b) => b[1] - a[1])
		if (entries.length === 0) continue

		for (let rank = 0; rank < entries.length; rank++) {
			const [nodeId] = entries[rank]!
			const rrf = 1 / (k + rank + 1)
			fused.set(nodeId, (fused.get(nodeId) ?? 0) + rrf)
		}
	}

	return [...fused.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, topK)
}
